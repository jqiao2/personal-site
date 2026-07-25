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

  // --- Targeted topology corrections (geometry). Runs BEFORE offset packing so the
  //     parallel-line offsets are recomputed for the corrected shapes. The MTA source
  //     geometry occasionally mis-threads a service across a junction; these fix the
  //     specific spots that diverge from the official diagram (the source of truth). ---
  {
    const findSt = (name, svc) => STATIONS.find((s) => s.name === name && s.svcs.includes(svc));
    const segColor = (svc) => lineColor[tokenToTrunk[svc]];
    const matchSeg = (s, svc, A, B) =>
      s.svc === svc && ((s.a === A.id && s.b === B.id) || (s.a === B.id && s.b === A.id));
    function removeSeg(svc, nameA, nameB) {
      const A = findSt(nameA, svc), B = findSt(nameB, svc);
      if (!A || !B) { console.warn('  correction removeSeg: station not found', svc, nameA, nameB); return; }
      const before = SEGMENTS.length;
      const kept = SEGMENTS.filter((s) => !matchSeg(s, svc, A, B));
      SEGMENTS.length = 0; SEGMENTS.push(...kept);
      if (SEGMENTS.length === before) console.warn('  correction removeSeg: no segment', svc, nameA, nameB);
    }
    function addSeg(svc, nameA, nameB, pts) {
      const A = findSt(nameA, svc), B = findSt(nameB, svc);
      if (!A || !B) { console.warn('  correction addSeg: station not found', svc, nameA, nameB); return; }
      const a = A.id, b = B.id;
      const id = svc + '|' + (a < b ? a + '|' + b : b + '|' + a);
      SEGMENTS.push({ id, svc, o: 0, color: segColor(svc), a, b, pts: pts || [[A.x, A.y], [B.x, B.y]] });
    }
    const findSeg = (svc, nameA, nameB) => {
      const A = findSt(nameA, svc), B = findSt(nameB, svc);
      if (!A || !B) return null;
      return SEGMENTS.find((s) => matchSeg(s, svc, A, B)) || null;
    };
    function setSegPts(svc, nameA, nameB, pts) {
      const seg = findSeg(svc, nameA, nameB);
      if (!seg) { console.warn('  correction setSegPts: no segment', svc, nameA, nameB); return; }
      // Keep pts oriented a -> b so endpoints stay attached to the right stations.
      const A = findSt(nameA, svc);
      seg.pts = seg.a === A.id ? pts.map((p) => p.slice()) : pts.slice().reverse().map((p) => p.slice());
    }
    function copySegPts(fromSvc, toSvc, nameA, nameB) {
      const src = findSeg(fromSvc, nameA, nameB), dst = findSeg(toSvc, nameA, nameB);
      if (!src || !dst) { console.warn('  correction copySegPts: missing', fromSvc, toSvc, nameA, nameB); return; }
      const A = findSt(nameA, toSvc);
      // src.pts run src.a -> src.b; re-orient to dst's a -> b.
      const base = src.a === dst.a ? src.pts : src.pts.slice().reverse();
      dst.pts = base.map((p) => p.slice());
    }

    // Standard corner radius (diagram units). The official diagram rounds every
    // bend to one consistent radius; the reconstructed geometry has a mix of hard
    // corners and pre-rounded ones. Measured off the source's own rounded corners
    // (e.g. the 6 at St Mary's) this is ~6.7 units.
    const CORNER_R = 6.7;
    // Replace a hard corner at each interior vertex with a circular fillet of
    // radius R (capped so it never eats more than ~45% of either adjoining edge).
    // Vertices that are already gentle (turn < ~8 deg) are left untouched so
    // existing smooth arcs are not disturbed.
    function roundCorners(pts, R = CORNER_R, steps = 8) {
      if (pts.length < 3) return pts.map((p) => p.slice());
      const out = [pts[0].slice()];
      for (let i = 1; i < pts.length - 1; i++) {
        const P = pts[i], A = pts[i - 1], B = pts[i + 1];
        let v1x = A[0] - P[0], v1y = A[1] - P[1], v2x = B[0] - P[0], v2y = B[1] - P[1];
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 < 1e-6 || l2 < 1e-6) { continue; }
        v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
        let dot = v1x * v2x + v1y * v2y; dot = Math.max(-1, Math.min(1, dot));
        const ang = Math.acos(dot);            // interior angle at P
        if (ang > Math.PI - 0.14) { out.push(P.slice()); continue; } // ~straight
        let t = R / Math.tan(ang / 2);         // tangent length from P
        t = Math.min(t, l1 * 0.45, l2 * 0.45);
        const r = t * Math.tan(ang / 2);       // actual radius after capping
        const T1 = [P[0] + v1x * t, P[1] + v1y * t];
        const T2 = [P[0] + v2x * t, P[1] + v2y * t];
        let bx = v1x + v2x, by = v1y + v2y;    // bisector toward the arc centre
        const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
        const C = [P[0] + bx * (r / Math.sin(ang / 2)), P[1] + by * (r / Math.sin(ang / 2))];
        let a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
        let a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
        let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        out.push(T1);
        for (let s = 1; s <= steps; s++) { const a = a1 + (da * s) / steps; out.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]); }
      }
      out.push(pts[pts.length - 1].slice());
      return out.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]);
    }

    // F: the source threads the F over the Manhattan Bridge alignment (phantom
    // Broadway-Lafayette/2 Av -> York St links) and leaves East Broadway a stub.
    // The real F runs the Rutgers tunnel: East Broadway -> York St -> Jay St.
    removeSeg('F', "B'way-Lafayette St", 'York St');
    removeSeg('F', '2 Av', 'York St');
    addSeg('F', 'East Broadway', 'York St');

    // 6 in the South Bronx. 3 Av-138 St / Brook Av / Cypress Av are meant to sit on
    // one horizontal; snap them (and the segments between) to a single y so the run
    // is dead flat. Straighten the 125 St elbow and the Cypress climb to clean
    // right angles — the global corner-rounding below gives them the house radius.
    {
      const yRow = 311;
      for (const nm of ['3 Av-138 St', 'Brook Av', 'Cypress Av']) { const s = findSt(nm, '6'); if (s) s.y = yRow; }
      setSegPts('6', '125 St', '3 Av-138 St', [[255.5, 341.8], [255.5, yRow], [290, yRow]]);
      setSegPts('6', '3 Av-138 St', 'Brook Av', [[290, yRow], [329, yRow]]);
      setSegPts('6', 'Brook Av', 'Cypress Av', [[329, yRow], [372.9, yRow]]);
      setSegPts('6', 'Cypress Av', "E 143 St-St Mary's St", [[372.9, yRow], [406.6, yRow], [406.6, 298.6]]);
    }

    // Rogers Junction (2/3/4/5 east of Franklin Av). Keep the red locals' branches
    // where they are (Nostrand/Kingston/Crown Hts stay on their 45-degree line;
    // President/Sterling/... on theirs) but redraw the two Franklin-Av branch starts
    // as a clean horizontal-then-45 elbow (no dip), and lay the green expresses on
    // the SAME centrelines so the fixed +/-0.5 offsets render each branch as one
    // tight red+green pair. The green expresses converge in from their approach
    // point; the global rounding turns every elbow into the house radius.
    {
      const GX = 530.5, GY = 841.6; // green (4/5) approach point at Franklin Av
      // Red 3 -> Nostrand: leave Franklin horizontally, bend up to meet the 45-deg
      // Nostrand->Kingston line squarely at Nostrand.
      setSegPts('3', 'Franklin Av', 'Nostrand Av', [[GX, 844], [542.9, 844], [557.6, 829.1]]);
      // Red 2 -> President: leave horizontally, bend down onto the 45-deg SE line.
      setSegPts('2', 'Franklin Av', 'President St', [[GX, 844], [539.6, 844], [558.5, 862.9]]);
      // Green 4 (express) traces the red 3's full NE centreline, converging in.
      const ne = [].concat(
        findSeg('3', 'Franklin Av', 'Nostrand Av').pts,
        findSeg('3', 'Nostrand Av', 'Kingston Av').pts.slice(1),
        findSeg('3', 'Kingston Av', 'Crown Hts-Utica Av').pts.slice(1),
      );
      setSegPts('4', 'Franklin Av', 'Crown Hts-Utica Av', [[GX, GY]].concat(ne.slice(1)));
      // Green 5 traces the red 2's SE centreline, converging in, then follows it.
      const se = findSeg('2', 'Franklin Av', 'President St').pts;
      setSegPts('5', 'Franklin Av', 'President St', [[GX, GY]].concat(se.slice(1)));
      for (const [a, b] of [
        ['President St', 'Sterling St'], ['Sterling St', 'Winthrop St'],
        ['Winthrop St', 'Church Av'], ['Church Av', 'Beverly Rd'],
        ['Beverly Rd', 'Newkirk Av'], ['Newkirk Av', 'Flatbush Av-Brooklyn College'],
      ]) copySegPts('2', '5', a, b);
    }

    // Global corner rounding: give every hard elbow on the map the one house radius,
    // matching the official diagram. Gentle vertices (already-curved source arcs)
    // are left untouched; the radius is capped to the adjoining edge lengths.
    for (const s of SEGMENTS) s.pts = roundCorners(s.pts);

    console.log('applied topology corrections; SEGMENTS now', SEGMENTS.length);
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

  // --- Targeted offset corrections (which side of a shared stretch each service
  //     draws on). Runs AFTER packing/realign, which set the magnitudes; here we
  //     only flip sides to match the official diagram. ---
  {
    const findSt = (name, svc) => STATIONS.find((s) => s.name === name && s.svcs.includes(svc));
    const findSeg2 = (svc, nameA, nameB) => {
      const A = findSt(nameA, svc), B = findSt(nameB, svc);
      if (!A || !B) return null;
      return SEGMENTS.find((s) => s.svc === svc &&
        ((s.a === A.id && s.b === B.id) || (s.a === B.id && s.b === A.id))) || null;
    };
    function flipOffset(svc, nameA, nameB) {
      const seg = findSeg2(svc, nameA, nameB);
      if (!seg) { console.warn('  offset flip: no segment', svc, nameA, nameB); return; }
      seg.o = -seg.o;
    }
    function setOffset(svc, nameA, nameB, o) {
      const seg = findSeg2(svc, nameA, nameB);
      if (!seg) { console.warn('  offset set: no segment', svc, nameA, nameB); return; }
      seg.o = o;
    }

    // F Rutgers tunnel: the F runs alone from East Broadway to Jay St, so keep a
    // single offset across East Broadway -> York -> Jay St; otherwise the packer's
    // realign leaves a small side-step (kink) at York St where the offset changes.
    {
      const jay = findSeg2('F', 'York St', 'Jay St-MetroTech');
      if (jay) setOffset('F', 'East Broadway', 'York St', jay.o);
    }

    // Lenox Av (2/3): the diagram runs the 3 WEST of the 2 from 110 St up to
    // 148/149 St (bullets read "3 2" west-to-east), with the two crossing over in
    // the 96 St curve. The source packs the 2 on the west, so flip every 2/3
    // segment at or north of Central Park North (110 St). The crossover lands at
    // 110 St; south of it (the 96 St curve) keeps the 2 on the west.
    const cpn = 'Central Park North (110 St)';
    flipOffset('2', '116 St', cpn);
    flipOffset('3', '116 St', cpn);
    flipOffset('2', '125 St', '116 St');
    flipOffset('3', '125 St', '116 St');
    flipOffset('2', '135 St', '125 St');
    flipOffset('3', '135 St', '125 St');
    flipOffset('3', '145 St', '135 St');
    flipOffset('3', 'Harlem-148 St', '145 St');
    flipOffset('2', '135 St', '149 St-Grand Concourse');

    // 6 on the Pelham line runs alone north of 125 St, but inherits the Lexington
    // bundle's offset (o=1) from the realign step. With a non-zero offset a 90-deg
    // turn between two stations can't render flat (the parallel normal rotates), so
    // the flat 3 Av-138/Brook/Cypress run and the elbows tilt. Recentre the lone
    // Pelham 6 on its own line (o=0); the only cost is a small step at 125 St where
    // it peels off the bundle eastbound anyway.
    {
      const pelham = new Set(['3 Av-138 St', 'Brook Av', 'Cypress Av', "E 143 St-St Mary's St",
        'E 149 St', 'Longwood Av', 'Hunts Point Av', 'Whitlock Av', 'Elder Av',
        'Morrison Av-Soundview Av', 'St Lawrence Av', 'Parkchester', 'Castle Hill Av',
        'Zerega Av', 'Westchester Sq-East Tremont Av', 'Middletown Rd', 'Buhre Av', 'Pelham Bay Park']);
      const stName = {}; STATIONS.forEach((s) => (stName[s.id] = s.name));
      for (const s of SEGMENTS) if (s.svc === '6' && (pelham.has(stName[s.a]) || pelham.has(stName[s.b]))) s.o = 0;
    }
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
