// Regenerates src/scripts/subway-data.js from the official MTA schematic subway
// diagram, published as an ArcGIS feature service. Run with: node scripts/generate-subway-data.mjs
//
// Source layout (the "layout as defined by" the reference map):
//   https://www.arcgis.com/apps/mapviewer/index.html?layers=1c7928d1e11f45a286f4312055435f8c
//   Feature service: NYC_Subway_Diagram_Updated_Layers
//     layer 1 = Station_Features (points, with a `services` list per station)
//     layer 2 = Subway_lines     (trunk-colour polylines: "1,2,3", "A,C,E", ...)
//
// The diagram's own schematic coordinates are scaled/flipped into a portrait
// canvas (north up). It is intentionally NOT geographically accurate — it matches
// the official diagram's placement.
//
// Each *service* (1, 2, 3, A, C, E, ...) gets its own set of track segments so it
// can be toggled independently and drawn as its own parallel line within a trunk.
// Segments are reconstructed by building a vertex graph per trunk (merging
// coincident junction vertices), projecting that service's stations onto their
// nearest edge, splitting, then walking station-to-station. Each service carries
// an offset index `o` used at render time to fan the parallel lines apart.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE =
  "https://services.arcgis.com/04HiymDgLlsbhaV4/arcgis/rest/services/NYC_Subway_Diagram_Updated_Layers/FeatureServer";
const OUT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "scripts", "subway-data.js");

// Trunk-line feature name -> trunk key; service token -> trunk key.
const lineNameToKey = {
  "1,2,3": "123", "4,5,6": "456", "7": "7", "A,C,E": "ACE",
  "B,D,F,M": "BDFM", "G": "G", "J,Z": "JZ", "L": "L",
  "N,Q,R,W": "NQRW", "Shuttle": "S", "SIRR": "SIR", "IBX": "IBX",
};
const tokenToTrunk = {
  "1": "123", "2": "123", "3": "123", "4": "456", "5": "456", "6": "456",
  "7": "7", A: "ACE", C: "ACE", E: "ACE", B: "BDFM", D: "BDFM", F: "BDFM",
  M: "BDFM", G: "G", J: "JZ", Z: "JZ", L: "L", N: "NQRW", Q: "NQRW",
  R: "NQRW", W: "NQRW", S: "S", SIR: "SIR",
};
// Services per trunk, in the order they fan out (offset order).
const trunkServices = {
  "123": ["1", "2", "3"], "456": ["4", "5", "6"], "7": ["7"],
  "ACE": ["A", "C", "E"], "BDFM": ["B", "D", "F", "M"], "G": ["G"],
  "JZ": ["J", "Z"], "L": ["L"], "NQRW": ["N", "Q", "R", "W"],
  "S": ["S"], "SIR": ["SIR"],
};
// Global service order for the summary / legend.
const SERVICE_ORDER = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M", "G", "J", "Z", "L", "N", "Q", "R", "W", "S", "SIR"];

// Offset index per service within its trunk (used to fan parallel lines apart).
const serviceMeta = {};
for (const trunk in trunkServices) {
  const svcs = trunkServices[trunk];
  svcs.forEach((svc, i) => (serviceMeta[svc] = { trunk, o: i - (svcs.length - 1) / 2 }));
}

// Bridge gaps in a trunk's geometry graph so every service can follow the tracks
// across small breaks in the source diagram (e.g. the A's Washington Heights tail,
// N/Q over the Manhattan Bridge). Repeatedly joins the closest vertices of two
// separate components while they are within maxD (keeps the 3 shuttles apart).
function connectComponents(nodePt, nbr, maxD) {
  for (let guard = 0; guard < 60; guard++) {
    const seen = new Set(), comps = [];
    for (const k in nodePt) {
      if (seen.has(k)) continue;
      const q = [k], c = []; seen.add(k);
      while (q.length) { const x = q.shift(); c.push(x); (nbr[x] || []).forEach((y) => { if (!seen.has(y)) { seen.add(y); q.push(y); } }); }
      comps.push(c);
    }
    if (comps.length <= 1) break;
    let best = null;
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++)
      for (const a of comps[i]) for (const b of comps[j]) {
        const A = nodePt[a], B = nodePt[b], d = Math.hypot(A[0] - B[0], A[1] - B[1]);
        if (!best || d < best.d) best = { d, a, b };
      }
    if (!best || best.d > maxD) break;
    (nbr[best.a] = nbr[best.a] || new Set()).add(best.b);
    (nbr[best.b] = nbr[best.b] || new Set()).add(best.a);
  }
}

async function queryLayer(id) {
  const url = `${BASE}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`layer ${id}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const [lnJson, stJson] = await Promise.all([queryLayer(2), queryLayer(1)]);

  // Trunk-line geometry (merge the three separate Shuttle features under "S").
  const lineColor = {};
  const rawLines = {};
  for (const f of lnJson.features) {
    const key = lineNameToKey[f.attributes.name];
    if (!key) continue;
    lineColor[key] = f.attributes.fill_color;
    (rawLines[key] = rawLines[key] || []).push(...f.geometry.paths);
  }

  // NYCT subway stations, parsing the `services` list (e.g. "NYCT-A,NYCT- C").
  const rawStations = [];
  for (const f of stJson.features) {
    const a = f.attributes;
    if (a.agency !== "NYCT" || a.type !== "Station") continue;
    const tokens = String(a.services || "")
      .replace(/NYCT-\s*/g, "").split(",").map((s) => s.trim()).filter(Boolean)
      .filter((t) => tokenToTrunk[t]);
    if (!tokens.length) continue; // skip depots/yards tagged BX/BK/QN/SI
    const trunks = [...new Set(tokens.map((t) => tokenToTrunk[t]))];
    rawStations.push({ id: a.point_id, name: a.name, gx: f.geometry.x, gy: f.geometry.y, svcs: tokens, trunks });
  }

  // Rotate the diagram so the ACE 8th-Ave trunk (34 St-Penn Station -> 145 St)
  // runs straight N/S. (This also lands the Queens Blvd E/F/M/R horizontal.)
  const findSt = (nm, svc) => rawStations.find((s) => s.name === nm && s.svcs.includes(svc));
  const penn = findSt('34 St-Penn Station', 'E'), n145 = findSt('145 St', 'A');
  const ROT = penn && n145 ? Math.atan2(n145.gx - penn.gx, n145.gy - penn.gy) : 0;
  const rot = (x, y) => [x * Math.cos(ROT) - y * Math.sin(ROT), x * Math.sin(ROT) + y * Math.cos(ROT)];
  console.log('rotation:', ((ROT * 180) / Math.PI).toFixed(3), 'deg CCW');
  for (const key in rawLines) rawLines[key] = rawLines[key].map((p) => p.map(([x, y]) => rot(x, y)));
  for (const s of rawStations) { const [rx, ry] = rot(s.gx, s.gy); s.gx = rx; s.gy = ry; }

  // Merge co-located station records — the diagram splits a single complex (e.g.
  // 34 St-Herald Sq) into one point per line. Collapse points drawn on the same
  // spot into a single station serving the union of their services.
  const MERGE_DIST = 2;
  const merged = [];
  for (const s of rawStations) {
    const hit = merged.find((m) => Math.hypot(m.gx - s.gx, m.gy - s.gy) < MERGE_DIST);
    if (hit) {
      hit.svcs = [...new Set([...hit.svcs, ...s.svcs])];
      hit.trunks = [...new Set([...hit.trunks, ...s.trunks])];
      if (s.name.length > hit.name.length) hit.name = s.name; // prefer the fuller label
    } else merged.push({ ...s });
  }
  console.log('stations merged:', rawStations.length, '->', merged.length);
  rawStations.length = 0; rawStations.push(...merged);

  // Second Ave Subway Phase 2 (Q north of 96 St, via 106/116/125 St) isn't open
  // yet — drop the Q from those stops so nothing is drawn there.
  for (const s of rawStations) {
    if (s.svcs.includes('Q') && ['106 St', '116 St', '125 St'].includes(s.name)) {
      s.svcs = s.svcs.filter((v) => v !== 'Q');
      s.trunks = [...new Set(s.svcs.map((t) => tokenToTrunk[t]).filter(Boolean))];
    }
  }
  const dropped = rawStations.filter((s) => !s.svcs.length).length;
  if (dropped) { const kept = rawStations.filter((s) => s.svcs.length); rawStations.length = 0; rawStations.push(...kept); console.log('dropped', dropped, 'now-serviceless stations'); }

  // Fit content bbox into a portrait canvas, flipping Y so north is up.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const key in rawLines) for (const p of rawLines[key]) for (const [x, y] of p) eat(x, y);
  for (const s of rawStations) eat(s.gx, s.gy);
  const PAD = 44, TARGET_W = 1040;
  const scale = (TARGET_W - 2 * PAD) / (maxX - minX);
  const W = TARGET_W;
  const H = Math.round((maxY - minY) * scale + 2 * PAD);
  const tx = (x) => +((x - minX) * scale + PAD).toFixed(1);
  const ty = (y) => +((maxY - y) * scale + PAD).toFixed(1);

  const STATIONS = rawStations.map((s) => ({
    id: s.id, name: s.name, x: tx(s.gx), y: ty(s.gy), svcs: s.svcs, trunks: s.trunks,
  }));
  const stById = {}; STATIONS.forEach((s) => (stById[s.id] = s));

  // --- Reconstruct per-service track segments ---
  const SEGMENTS = [];
  for (const trunk in trunkServices) {
    const paths = (rawLines[trunk] || []).map((p) => p.map(([x, y]) => [tx(x), ty(y)]));
    if (!paths.length) continue;
    const color = lineColor[trunk];
    const svcs = trunkServices[trunk];
    const n = svcs.length;

    // Base vertex graph for the trunk; node key = rounded coordinate so shared
    // junction vertices merge.
    const baseNodePt = {}, baseNbr = {};
    const vkey = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1);
    for (const p of paths) for (let i = 0; i < p.length - 1; i++) {
      const a = vkey(p[i]), b = vkey(p[i + 1]);
      baseNodePt[a] = p[i]; baseNodePt[b] = p[i + 1];
      if (a !== b) { (baseNbr[a] = baseNbr[a] || new Set()).add(b); (baseNbr[b] = baseNbr[b] || new Set()).add(a); }
    }

    svcs.forEach((svc, si) => {
      const o = si - (n - 1) / 2; // offset index, centered on 0
      const stationsOfSvc = STATIONS.filter((s) => s.svcs.includes(svc));
      if (stationsOfSvc.length < 2) return;

      // Clone the trunk graph for this service.
      const nodePt = Object.assign({}, baseNodePt);
      const nbr = {}; for (const k in baseNbr) nbr[k] = new Set(baseNbr[k]);
      const addEdge = (a, b) => { if (a === b) return; (nbr[a] = nbr[a] || new Set()).add(b); (nbr[b] = nbr[b] || new Set()).add(a); };

      // Project each station onto its nearest edge.
      const edges = [];
      for (const a in nbr) for (const b of nbr[a]) if (a < b) edges.push([a, b]);
      const onEdge = {};
      for (const s of stationsOfSvc) {
        let best = null;
        for (const [a, b] of edges) {
          const A = nodePt[a], B = nodePt[b];
          const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy || 1e-9;
          let t = ((s.x - A[0]) * dx + (s.y - A[1]) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = A[0] + t * dx, py = A[1] + t * dy;
          const d = (s.x - px) ** 2 + (s.y - py) ** 2;
          if (best === null || d < best.d) best = { d, a, b, t, px, py };
        }
        if (!best) continue;
        (onEdge[best.a + "|" + best.b] = onEdge[best.a + "|" + best.b] || []).push({ t: best.t, id: s.id, px: best.px, py: best.py });
      }

      // Split each edge at its projected stations.
      const stationAtNode = {};
      for (const ek in onEdge) {
        const [a, b] = ek.split("|");
        if (nbr[a]) nbr[a].delete(b); if (nbr[b]) nbr[b].delete(a);
        let prev = a;
        for (const st of onEdge[ek].sort((x, y) => x.t - y.t)) {
          const skey = "S" + st.id;
          nodePt[skey] = [st.px, st.py]; stationAtNode[skey] = st.id; addEdge(prev, skey); prev = skey;
        }
        addEdge(prev, b);
      }

      // Walk from each station node to the nearest station in every direction.
      // Cap the distance travelled: within a trunk each service uses only some
      // branches, and without a cap a walk wanders down another service's branch
      // (e.g. the D leaving Coney Island up the F's Culver line) and invents a
      // phantom "adjacency" to a far-away station.
      const MAX_WALK = 300;
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      const segSeen = {};
      for (const startKey in stationAtNode) {
        const startId = stationAtNode[startKey];
        const stack = [];
        for (const m of nbr[startKey] || []) stack.push({ node: m, prev: startKey, pts: [nodePt[startKey], nodePt[m]], len: dist(nodePt[startKey], nodePt[m]) });
        const visited = new Set([startKey]);
        let steps = 0;
        while (stack.length && steps++ < 8000) {
          const cur = stack.pop();
          if (visited.has(cur.node)) continue;
          visited.add(cur.node);
          const other = stationAtNode[cur.node];
          if (other && other !== startId) {
            const a = startId, b = other;
            const sid = svc + "|" + (a < b ? a + "|" + b : b + "|" + a);
            const prev = segSeen[sid];
            if (!prev || cur.pts.length < prev.pts.length) segSeen[sid] = { id: sid, svc, o, color, a, b, pts: cur.pts };
            continue; // stop at the station; don't walk through it
          }
          for (const w of nbr[cur.node] || []) {
            if (w === cur.prev || visited.has(w)) continue;
            const nlen = cur.len + dist(nodePt[cur.node], nodePt[w]);
            if (nlen <= MAX_WALK) stack.push({ node: w, prev: cur.node, pts: cur.pts.concat([nodePt[w]]), len: nlen });
          }
        }
      }

      const svcSegs = [];
      for (const sid in segSeen) {
        const s = segSeen[sid];
        s.pts = s.pts.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]);
        svcSegs.push(s);
      }

      // Bridge residual gaps within this service where the source geometry breaks
      // a line across a real adjacency the walk couldn't follow — the A's
      // Washington Heights tail, the N/Q over the Manhattan Bridge, etc.
      const BRIDGE_MAX = 260;
      for (let guard = 0; guard < 30; guard++) {
        const adj = {}, nodes = new Set();
        svcSegs.forEach((s) => { nodes.add(s.a); nodes.add(s.b); (adj[s.a] = adj[s.a] || []).push(s.b); (adj[s.b] = adj[s.b] || []).push(s.a); });
        // include stations with no segments yet, so isolated stops get connected
        stationsOfSvc.forEach((s) => nodes.add(s.id));
        if (nodes.size < 2) break;
        const seen = new Set(), comps = [];
        for (const nn of nodes) {
          if (seen.has(nn)) continue;
          const q = [nn], c = []; seen.add(nn);
          while (q.length) { const x = q.shift(); c.push(x); (adj[x] || []).forEach((y) => { if (!seen.has(y)) { seen.add(y); q.push(y); } }); }
          comps.push(c);
        }
        if (comps.length < 2) break;
        let bestB = null;
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++)
          for (const a of comps[i]) for (const b of comps[j]) {
            const d = Math.hypot(stById[a].x - stById[b].x, stById[a].y - stById[b].y);
            if (!bestB || d < bestB.d) bestB = { d, a, b };
          }
        if (!bestB || bestB.d > BRIDGE_MAX) break;
        const { a, b } = bestB;
        const sid = svc + "|" + (a < b ? a + "|" + b : b + "|" + a);
        svcSegs.push({ id: sid, svc, o, color, a, b, pts: [[stById[a].x, stById[a].y], [stById[b].x, stById[b].y]] });
      }

      SEGMENTS.push(...svcSegs);
    });
  }

  // --- Remove redundant triangle edges. A real service is tree-like, so a 3-cycle
  //     means one edge is spurious: either an express skip (much longer than the
  //     other two — drop the long one) or a wye cross-link (a roughly equilateral
  //     triangle — drop the edge whose third vertex is least "between" its ends). ---
  {
    const pos = {}; STATIONS.forEach((s) => (pos[s.id] = s));
    const D = (a, b) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
    const bySvc = {};
    for (const sg of SEGMENTS) (bySvc[sg.svc] = bySvc[sg.svc] || []).push(sg);
    const remove = new Set();
    for (const svc in bySvc) {
      for (let iter = 0; iter < 500; iter++) {
        const adj = {}, edge = {};
        for (const s of bySvc[svc]) {
          if (remove.has(s)) continue;
          (adj[s.a] = adj[s.a] || new Set()).add(s.b);
          (adj[s.b] = adj[s.b] || new Set()).add(s.a);
          edge[s.a + '|' + s.b] = s; edge[s.b + '|' + s.a] = s;
        }
        let tri = null;
        for (const a in adj) {
          const na = [...adj[a]];
          for (let i = 0; i < na.length && !tri; i++) for (let j = i + 1; j < na.length; j++) if (adj[na[i]].has(na[j])) { tri = [a, na[i], na[j]]; break; }
          if (tri) break;
        }
        if (!tri) break;
        const [a, b, c] = tri;
        const es = [[a, b], [b, c], [a, c]].map(([x, y]) => ({ x, y, d: D(x, y), seg: edge[x + '|' + y] })).sort((p, q) => p.d - q.d);
        // A vertex with no neighbours outside the triangle is a pure pass-through
        // (a station the third edge skips): drop the edge that bypasses it.
        const ext = (v) => [...adj[v]].filter((n) => n !== a && n !== b && n !== c).length;
        const mid = tri.filter((v) => ext(v) === 0);
        let rm;
        if (mid.length === 1) rm = es.find((e) => e.x !== mid[0] && e.y !== mid[0]);
        else if (es[2].d > 2 * es[1].d) rm = es[2];
        else {
          const dr = (e) => { const t = tri.find((v) => v !== e.x && v !== e.y); return (D(e.x, t) + D(t, e.y)) / (e.d || 1); };
          rm = es.slice().sort((p, q) => dr(q) - dr(p))[0];
        }
        remove.add(rm.seg);
      }
    }
    const afterTri = remove.size;
    // Minimum spanning tree per service: a real service is a tree, so any extra
    // edge that closes a cycle is a redundant express-skip chord (e.g. D Grand St
    // -> Coney Island, N Atlantic -> 86 St). Processing edges shortest-first keeps
    // the local path and drops the long shortcuts.
    for (const svc in bySvc) {
      const segs = bySvc[svc].filter((s) => !remove.has(s)).map((s) => ({ s, w: D(s.a, s.b) })).sort((a, b) => a.w - b.w);
      const parent = {};
      const find = (x) => (parent[x] === undefined ? (parent[x] = x) : parent[x] === x ? x : (parent[x] = find(parent[x])));
      for (const { s } of segs) {
        if (find(s.a) === find(s.b)) remove.add(s);
        else parent[find(s.a)] = find(s.b);
      }
    }
    const kept = SEGMENTS.filter((s) => !remove.has(s));
    console.log('removed', afterTri, 'triangle +', remove.size - afterTri, 'redundant chord edges');
    SEGMENTS.length = 0; SEGMENTS.push(...kept);
  }

  // --- Pack parallel service lines per stretch so the services actually present
  //     are centered with a uniform gap; the bundle closes up where a line branches
  //     away (e.g. past Franklin Av). Offset is stored per segment — services that
  //     share a stretch overlap on the centerline, so proximity finds them. ---
  const svcRank = {}; SERVICE_ORDER.forEach((s, i) => (svcRank[s] = i));
  const ptSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-9; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); };
  const ptToPath = (p, pts) => { if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); let m = Infinity; for (let i = 0; i < pts.length - 1; i++) { const d = ptSeg(p, pts[i], pts[i + 1]); if (d < m) m = d; } return m; };
  const EPS = 4;
  const byTrunk = {};
  for (const sg of SEGMENTS) (byTrunk[serviceMeta[sg.svc].trunk] = byTrunk[serviceMeta[sg.svc].trunk] || []).push(sg);
  for (const t in byTrunk) {
    const segs = byTrunk[t];
    for (const S of segs) {
      const mid = S.pts[Math.floor(S.pts.length / 2)];
      const present = new Set([S.svc]);
      for (const T of segs) if (T.svc !== S.svc && ptToPath(mid, T.pts) < EPS) present.add(T.svc);
      const arr = [...present].sort((a, b) => svcRank[a] - svcRank[b]);
      S.o = arr.indexOf(S.svc) - (arr.length - 1) / 2;
      S._cnt = arr.length;
    }
  }

  // Realign lone runs: when a line branches off on its own (e.g. the 1 up Broadway
  // north of 96 St, while 2/3 peel off to Lenox) it should keep the offset it had
  // in the bundle and continue straight, not recentre onto the trunk centreline.
  {
    const bySvc = {};
    for (const s of SEGMENTS) (bySvc[s.svc] = bySvc[s.svc] || []).push(s);
    for (const svc in bySvc) {
      const segs = bySvc[svc];
      for (let iter = 0; iter < 300; iter++) {
        let changed = false;
        for (const s of segs) {
          if (s._cnt !== 1 || s._done) continue;
          const nb = segs.find((t) => t !== s && (t._cnt > 1 || t._done) && t.o !== s.o && (t.a === s.a || t.a === s.b || t.b === s.a || t.b === s.b));
          if (nb) { s.o = nb.o; s._done = true; changed = true; }
        }
        if (!changed) break;
      }
    }
    for (const s of SEGMENTS) { delete s._cnt; delete s._done; }
  }

  const SERVICES = SERVICE_ORDER
    .filter((svc) => SEGMENTS.some((s) => s.svc === svc))
    .map((svc) => ({ svc, trunk: tokenToTrunk[svc], color: lineColor[tokenToTrunk[svc]] }));

  const out =
    "// AUTO-GENERATED by scripts/generate-subway-data.mjs from the MTA schematic subway\n" +
    "// diagram (ArcGIS feature service \"NYC_Subway_Diagram_Updated_Layers\"). Coordinates\n" +
    "// are the diagram's own schematic layout, scaled/flipped into a " + W + "x" + H + " canvas\n" +
    "// (north up). Not geographically accurate. Each service (1,2,3,A,C,E,...) is its own\n" +
    "// line; SEGMENTS carry `o`, an offset index used to fan parallel lines apart.\n\n" +
    "export const CANVAS = { W: " + W + ", H: " + H + " };\n\n" +
    "export const SERVICES = " + JSON.stringify(SERVICES) + ";\n\n" +
    "export const STATIONS = " + JSON.stringify(STATIONS) + ";\n\n" +
    "export const SEGMENTS = " + JSON.stringify(SEGMENTS) + ";\n";
  fs.writeFileSync(OUT, out);
  console.log(`Wrote ${OUT}`);
  console.log(`canvas ${W}x${H} · SERVICES ${SERVICES.length} · STATIONS ${STATIONS.length} · SEGMENTS ${SEGMENTS.length}`);
  for (const s of SERVICES) console.log("   " + s.svc.padEnd(4), "segments", SEGMENTS.filter((x) => x.svc === s.svc).length);
}

main().catch((e) => { console.error(e); process.exit(1); });
