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
// the official diagram's placement. Track segments are reconstructed by building a
// vertex graph per trunk line (merging coincident junction vertices), projecting
// each station onto its nearest edge, splitting, then walking station-to-station.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE =
  "https://services.arcgis.com/04HiymDgLlsbhaV4/arcgis/rest/services/NYC_Subway_Diagram_Updated_Layers/FeatureServer";
const OUT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "scripts", "subway-data.js");

// Trunk-line feature name -> group key; service token -> group key.
const lineNameToKey = {
  "1,2,3": "123", "4,5,6": "456", "7": "7", "A,C,E": "ACE",
  "B,D,F,M": "BDFM", "G": "G", "J,Z": "JZ", "L": "L",
  "N,Q,R,W": "NQRW", "Shuttle": "S", "SIRR": "SIR", "IBX": "IBX",
};
const tokenToGroup = {
  "1": "123", "2": "123", "3": "123", "4": "456", "5": "456", "6": "456",
  "7": "7", A: "ACE", C: "ACE", E: "ACE", B: "BDFM", D: "BDFM", F: "BDFM",
  M: "BDFM", G: "G", J: "JZ", Z: "JZ", L: "L", N: "NQRW", Q: "NQRW",
  R: "NQRW", W: "NQRW", S: "S", SIR: "SIR",
};
// Sidebar order + labels.
const GROUP_META = [
  { key: "123", label: "1 2 3" }, { key: "456", label: "4 5 6" },
  { key: "7", label: "7" }, { key: "ACE", label: "A C E" },
  { key: "BDFM", label: "B D F M" }, { key: "G", label: "G" },
  { key: "JZ", label: "J Z" }, { key: "L", label: "L" },
  { key: "NQRW", label: "N Q R W" }, { key: "S", label: "Shuttles" },
  { key: "SIR", label: "Staten Island Ry" },
];

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
      .replace(/NYCT-\s*/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    const groups = [...new Set(tokens.map((t) => tokenToGroup[t]).filter(Boolean))];
    if (!groups.length) continue; // skip depots/yards tagged BX/BK/QN/SI
    rawStations.push({ id: a.point_id, name: a.name, gx: f.geometry.x, gy: f.geometry.y, svcs: tokens, groups });
  }

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

  const LINES = GROUP_META.map((g) => g.key).concat(["IBX"]).filter((k) => rawLines[k]).map((key) => ({
    key, color: lineColor[key], paths: rawLines[key].map((p) => p.map(([x, y]) => [tx(x), ty(y)])),
  }));
  const STATIONS = rawStations.map((s) => ({
    id: s.id, name: s.name, x: tx(s.gx), y: ty(s.gy), svcs: s.svcs, groups: s.groups,
  }));

  // Reconstruct clickable track segments per trunk line.
  const SEGMENTS = [];
  for (const g of GROUP_META) {
    const paths = (rawLines[g.key] || []).map((p) => p.map(([x, y]) => [tx(x), ty(y)]));
    if (!paths.length) continue;

    // Vertex graph; node key = rounded coordinate so shared junction vertices merge.
    const nodePt = {}, nbr = {};
    const vkey = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1);
    const addEdge = (a, b) => { if (a === b) return; (nbr[a] = nbr[a] || new Set()).add(b); (nbr[b] = nbr[b] || new Set()).add(a); };
    for (const p of paths) for (let i = 0; i < p.length - 1; i++) {
      const a = vkey(p[i]), b = vkey(p[i + 1]);
      nodePt[a] = p[i]; nodePt[b] = p[i + 1]; addEdge(a, b);
    }

    // Project each station onto its nearest edge (handles under-sampled lines like SIR).
    const groupStations = STATIONS.filter((s) => s.groups.includes(g.key));
    const edges = [];
    for (const a in nbr) for (const b of nbr[a]) if (a < b) edges.push([a, b]);
    const onEdge = {};
    for (const s of groupStations) {
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

    // Split each edge at its projected stations, inserting station nodes in order.
    const stationAtNode = {};
    for (const ek in onEdge) {
      const [a, b] = ek.split("|");
      nbr[a].delete(b); nbr[b].delete(a);
      let prev = a;
      for (const st of onEdge[ek].sort((x, y) => x.t - y.t)) {
        const skey = "S" + st.id;
        nodePt[skey] = [st.px, st.py]; stationAtNode[skey] = st.id; addEdge(prev, skey); prev = skey;
      }
      addEdge(prev, b);
    }

    // Walk from each station node to the nearest station in every direction.
    const segSeen = {};
    for (const startKey in stationAtNode) {
      const startId = stationAtNode[startKey];
      const stack = [];
      for (const m of nbr[startKey] || []) stack.push({ node: m, prev: startKey, pts: [nodePt[startKey], nodePt[m]] });
      const visited = new Set([startKey]);
      let steps = 0;
      while (stack.length && steps++ < 6000) {
        const cur = stack.pop();
        if (visited.has(cur.node)) continue;
        visited.add(cur.node);
        const other = stationAtNode[cur.node];
        if (other && other !== startId) {
          const a = startId, b = other;
          const sid = g.key + "|" + (a < b ? a + "|" + b : b + "|" + a);
          const prev = segSeen[sid];
          if (!prev || cur.pts.length < prev.pts.length) segSeen[sid] = { id: sid, key: g.key, color: lineColor[g.key], a, b, pts: cur.pts };
          continue; // stop at the station; don't walk through it
        }
        for (const w of nbr[cur.node] || []) if (w !== cur.prev && !visited.has(w)) stack.push({ node: w, prev: cur.node, pts: cur.pts.concat([nodePt[w]]) });
      }
    }
    for (const sid in segSeen) {
      const s = segSeen[sid];
      s.pts = s.pts.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]);
      SEGMENTS.push(s);
    }
  }

  // Bridge small residual gaps where the source geometry breaks a line across a
  // real adjacency (e.g. A train 145<->155 St). The distance cap keeps the three
  // genuinely separate shuttles apart.
  const BRIDGE_MAX = 34;
  const stById = {}; STATIONS.forEach((s) => (stById[s.id] = s));
  for (const g of GROUP_META) {
    for (let guard = 0; guard < 12; guard++) {
      const adj = {}, nodes = new Set();
      SEGMENTS.filter((s) => s.key === g.key).forEach((s) => {
        nodes.add(s.a); nodes.add(s.b);
        (adj[s.a] = adj[s.a] || []).push(s.b); (adj[s.b] = adj[s.b] || []).push(s.a);
      });
      if (nodes.size < 2) break;
      const seen = new Set(), comps = [];
      for (const n of nodes) {
        if (seen.has(n)) continue;
        const q = [n], c = []; seen.add(n);
        while (q.length) { const x = q.shift(); c.push(x); (adj[x] || []).forEach((y) => { if (!seen.has(y)) { seen.add(y); q.push(y); } }); }
        comps.push(c);
      }
      if (comps.length < 2) break;
      let best = null;
      for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++)
        for (const a of comps[i]) for (const b of comps[j]) {
          const d = Math.hypot(stById[a].x - stById[b].x, stById[a].y - stById[b].y);
          if (!best || d < best.d) best = { d, a, b };
        }
      if (!best || best.d > BRIDGE_MAX) break;
      const { a, b } = best;
      const sid = g.key + "|" + (a < b ? a + "|" + b : b + "|" + a);
      SEGMENTS.push({ id: sid, key: g.key, color: lineColor[g.key], a, b, bridge: 1, pts: [[stById[a].x, stById[a].y], [stById[b].x, stById[b].y]] });
    }
  }

  const GROUPS = GROUP_META.map((g) => ({ key: g.key, label: g.label, color: lineColor[g.key] }));
  const out =
    "// AUTO-GENERATED by scripts/generate-subway-data.mjs from the MTA schematic subway\n" +
    "// diagram (ArcGIS feature service \"NYC_Subway_Diagram_Updated_Layers\"). Coordinates\n" +
    "// are the diagram's own schematic layout, scaled/flipped into a " + W + "x" + H + " canvas\n" +
    "// (north up). Not geographically accurate — it matches the official diagram's placement.\n\n" +
    "export const CANVAS = { W: " + W + ", H: " + H + " };\n\n" +
    "export const GROUPS = " + JSON.stringify(GROUPS) + ";\n\n" +
    "export const LINES = " + JSON.stringify(LINES) + ";\n\n" +
    "export const STATIONS = " + JSON.stringify(STATIONS) + ";\n\n" +
    "export const SEGMENTS = " + JSON.stringify(SEGMENTS) + ";\n";
  fs.writeFileSync(OUT, out);
  console.log(`Wrote ${OUT}`);
  console.log(`canvas ${W}x${H} · LINES ${LINES.length} · STATIONS ${STATIONS.length} · SEGMENTS ${SEGMENTS.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
