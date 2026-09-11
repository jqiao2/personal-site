// Route-inspection ordering, checked without the network or a map.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/postman.test.mjs
import assert from 'node:assert/strict';
import { eulerRoute } from '../src/lib/postman.ts';

// Helper: build a graph from node coords and [a,b] edges (straight strokes).
function g(nodes, pairs) {
	return { nodes, edges: pairs.map(([a, b]) => ({ a, b, pts: [nodes[a], nodes[b]] })) };
}
// How much of the path retraces a stroke already ridden (undirected segments).
function retraced(path) {
	const key = (p, q) => {
		const a = `${p[0]},${p[1]}`, b = `${q[0]},${q[1]}`;
		return a < b ? `${a}|${b}` : `${b}|${a}`;
	};
	const seen = new Set();
	let total = 0, reused = 0;
	for (let i = 1; i < path.length; i++) {
		const L = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
		if (L === 0) continue;
		total += L;
		const k = key(path[i - 1], path[i]);
		if (seen.has(k)) reused += L; else seen.add(k);
	}
	return { total, reused };
}
function covers(path, nodes, pairs) {
	const { reused } = retraced(path);
	const need = new Set(pairs.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
	const got = new Set();
	// map path points back to node indices
	const idx = (p) => nodes.findIndex((n) => n[0] === p[0] && n[1] === p[1]);
	for (let i = 1; i < path.length; i++) {
		const a = idx(path[i - 1]), b = idx(path[i]);
		if (a < 0 || b < 0) continue;
		got.add(a < b ? `${a}|${b}` : `${b}|${a}`);
	}
	for (const e of need) assert.ok(got.has(e), `edge ${e} not covered`);
	return reused;
}

// 1. A simple path A-B-C (two odd endpoints): Eulerian trail exists, zero doubling.
{
	const nodes = [[0, 0], [1, 0], [2, 0]];
	const pairs = [[0, 1], [1, 2]];
	const { path, doubled } = eulerRoute(g(nodes, pairs));
	assert.equal(doubled, 0, 'a path needs no backtracking');
	assert.equal(retraced(path).reused, 0);
	covers(path, nodes, pairs);
}

// 2. A single stroke A-B: the two endpoints are the trail's ends, so it is
//    ridden once — the open trail's whole point over a forced-closed circuit.
{
	const nodes = [[0, 0], [1, 0]];
	const { path, doubled } = eulerRoute(g(nodes, [[0, 1]]));
	assert.equal(doubled, 0, 'a lone stroke is ridden once, not doubled');
	assert.equal(path.length, 2); // A -> B
}

// 3. A square loop (all degree 2): Eulerian circuit, zero doubling.
{
	const nodes = [[0, 0], [1, 0], [1, 1], [0, 1]];
	const pairs = [[0, 1], [1, 2], [2, 3], [3, 0]];
	const { doubled } = eulerRoute(g(nodes, pairs));
	assert.equal(doubled, 0, 'a closed loop traces once');
}

// 4. Königsberg-style: a "plus/star" with a center and 4 spokes. Center degree 4
//    (even), 4 leaf endpoints (odd). Matching leaves 2 leaves as ends, doubles
//    the shortest connection for the other pair — two spokes ridden twice.
{
	const nodes = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, 1.5]];
	const pairs = [[0, 1], [0, 2], [0, 3], [3, 4]]; // spokes east, west, up-to-3, 3-to-4
	const { path, doubled } = eulerRoute(g(nodes, pairs));
	// 3 odd leaves after collapse? degrees: 0->3(odd),1->1,2->1,3->2,4->1 => odd {0,1,2,4}
	// leave two farthest as ends, double the cheapest pairing. Just assert coverage
	// and that *some* doubling happened but it is bounded by the total length.
	const reused = covers(path, nodes, pairs);
	assert.ok(doubled > 0, 'an odd graph must double something');
	assert.ok(reused <= 2.0001, 'doubling is the cheap pairing, not everything');
}

// 5. Two disconnected strokes get bridged (and the bridge is ridden, doubled).
{
	const nodes = [[0, 0], [1, 0], [5, 0], [6, 0]];
	const pairs = [[0, 1], [2, 3]];
	const { path, doubled } = eulerRoute(g(nodes, pairs));
	covers(path, nodes, pairs);
	assert.ok(doubled >= 4, 'the ~4-unit gap bridge is ridden out and back');
}

console.log('postman.test.mjs OK');
