// Image → graph vectorizing, checked without a canvas or the WASM tracer.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/line-art.test.mjs
import assert from 'node:assert/strict';
import { imageToMask, buildGraph, normalizeGraph, imageToGraph } from '../src/lib/line-art.ts';

// Fake ImageData: a horizontal 1px line plus one stray speck.
function makeImg(w, h, dark) {
	const data = new Uint8ClampedArray(w * h * 4).fill(255); // white, opaque
	for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
	for (const [x, y] of dark) {
		const i = (y * w + x) * 4;
		data[i] = data[i + 1] = data[i + 2] = 0; // black
	}
	return { width: w, height: h, data };
}

// 1. imageToMask thresholds dark pixels and despeckles tiny blobs.
{
	const line = [];
	for (let x = 1; x < 9; x++) line.push([x, 5]); // an 8px stroke
	const speck = [[0, 0]]; // a lone pixel — should be despeckled
	const mask = imageToMask(makeImg(10, 10, [...line, ...speck]), 128, 3);
	let ink = 0;
	for (const v of mask.ink) ink += v;
	assert.equal(ink, 8, 'the stroke survives, the 1px speck is removed');
	assert.equal(mask.ink[5 * 10 + 5], 1);
	assert.equal(mask.ink[0], 0);
}

// 2. buildGraph snaps shared endpoints into junction nodes. A "plus": two
//    strokes crossing at the centre, given as four polylines meeting there.
{
	const c = [5, 5];
	const polylines = [
		[[5, 0], [5, 5]], // north spoke -> centre
		[[5, 5], [5, 9]], // centre -> south
		[[0, 5], [5, 5]], // west -> centre
		[[5, 5], [9, 5]], // centre -> east
	];
	const g = buildGraph(polylines, 2, 0.5);
	// 5 nodes: centre + 4 tips.
	assert.equal(g.nodes.length, 5);
	assert.equal(g.edges.length, 4);
	// The centre node has degree 4.
	const deg = g.nodes.map(() => 0);
	for (const e of g.edges) { deg[e.a]++; deg[e.b]++; }
	assert.equal(Math.max(...deg), 4, 'the crossing is one degree-4 node');
	assert.equal(deg.filter((d) => d === 1).length, 4, 'four leaf tips');
}

// 3. normalizeGraph centres and fits into the unit box (longer axis in [-.5,.5]).
{
	const g = { nodes: [[0, 0], [10, 0], [10, 4]], edges: [{ a: 0, b: 1, pts: [[0, 0], [10, 0]] }] };
	const { graph, paths } = normalizeGraph(g);
	const xs = graph.nodes.map((n) => n[0]);
	assert.ok(Math.min(...xs) >= -0.5001 && Math.max(...xs) <= 0.5001, 'fits the box');
	assert.equal(paths.length, 1);
}

// 4. imageToGraph end-to-end with a fake tracer (skips the WASM).
{
	const img = makeImg(12, 12, [[3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6]]);
	const tracer = { fromBoolArray: () => ({ polylines: [[[3, 6], [8, 6]]] }) };
	const { graph, paths } = imageToGraph(img, tracer, { snapDist: 2 });
	assert.equal(graph.edges.length, 1);
	assert.equal(paths.length, 1);
}

console.log('line-art.test.mjs OK');
