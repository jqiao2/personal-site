// The outline-tracing geometry, checked without touching the network.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/bike-route.test.mjs
import assert from 'node:assert/strict';
import {
	outerRing,
	resample,
	pathLength,
	deviation,
	toGPX,
	haversine,
	normalizeShape,
	orientRing,
	removeBacktracks,
	removeLoops,
	retracedFraction,
} from '../src/lib/bike-route.ts';

// A ~1° square near the equator, as each GeoJSON shape the picker can hand us.
const square = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1],
	[0, 0],
];

// outerRing unwraps Feature, FeatureCollection, and picks the largest piece.
assert.deepEqual(outerRing({ type: 'Polygon', coordinates: [square] }), square);
assert.deepEqual(outerRing({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square] } }), square);
const big = square;
const small = [
	[10, 10],
	[10.1, 10],
	[10.1, 10.1],
	[10, 10.1],
	[10, 10],
];
const picked = outerRing({
	type: 'MultiPolygon',
	coordinates: [[small], [big]],
});
assert.deepEqual(picked, big, 'MultiPolygon should trace the largest piece (the mainland)');

// resample drops points at the requested spacing and closes the loop.
const perimeter = pathLength(square); // ~445 km around a 1° square at the equator
const wps = resample(square, 50000); // every 50 km
assert.ok(wps.length >= 8, `expected several waypoints, got ${wps.length}`);
assert.deepEqual(wps[0], wps[wps.length - 1], 'resampled ring should close back to the start');
// Arc-length spacing is the target, so no straight-line hop exceeds it (a hop
// crossing a corner is legitimately shorter — the chord cuts the angle).
for (let i = 1; i < wps.length; i++) {
	const d = haversine(wps[i - 1], wps[i]);
	assert.ok(d > 0 && d <= 50500, `hop ${i} was ${d.toFixed(0)}m, expected <= ~50000`);
}
// Chords cut corners, so the resampled loop is a touch shorter than the true
// perimeter — never longer, and within ~10% at this spacing.
const sampledLen = pathLength(wps);
assert.ok(sampledLen <= perimeter + 1 && sampledLen > perimeter * 0.9, 'resampled length tracks the perimeter');

// deviation is ~0 when the route IS the outline, and grows when it strays.
const onLine = deviation(square, square);
assert.ok(onLine.max < 1, `a route on the outline should have ~0 deviation, got ${onLine.max}`);
const strayed = deviation(
	[[0.5, -0.1]], // 0.1° south of the bottom edge ≈ 11 km
	square
);
assert.ok(strayed.max > 10000 && strayed.max < 12000, `expected ~11km deviation, got ${strayed.max.toFixed(0)}`);

// GPX is well-formed and carries every point.
const gpx = toGPX(square, 'Test <loop> & ride');
assert.ok(gpx.startsWith('<?xml'), 'GPX declares xml');
assert.match(gpx, /<trkpt lat="0.000000" lon="0.000000">/);
assert.equal((gpx.match(/<trkpt /g) || []).length, square.length, 'every point becomes a trkpt');
assert.ok(!gpx.includes('<loop>'), 'name is escaped against breaking the XML');

// normalizeShape centres the shape and fits its longer axis in [-0.5, 0.5].
const norm = normalizeShape(square);
let nMinX = Infinity, nMaxX = -Infinity, nMinY = Infinity, nMaxY = -Infinity;
for (const [x, y] of norm) {
	nMinX = Math.min(nMinX, x); nMaxX = Math.max(nMaxX, x);
	nMinY = Math.min(nMinY, y); nMaxY = Math.max(nMaxY, y);
}
assert.ok(Math.abs(nMinX + nMaxX) < 1e-9 && Math.abs(nMinY + nMaxY) < 1e-9, 'normalized shape is centred on the origin');
assert.ok(Math.max(nMaxX - nMinX, nMaxY - nMinY) - 1 < 1e-9, 'longer axis spans 1.0');
// Longitude is squeezed by cos(lat): a square at 60°N (cos = 0.5) is half as
// wide as it is tall, so height dominates and spans the full [-0.5, 0.5].
const north = [
	[0, 60],
	[1, 60],
	[1, 61],
	[0, 61],
	[0, 60],
];
const nn = normalizeShape(north);
const w = Math.max(...nn.map((p) => p[0])) - Math.min(...nn.map((p) => p[0]));
const h = Math.max(...nn.map((p) => p[1])) - Math.min(...nn.map((p) => p[1]));
assert.ok(Math.abs(h - 1) < 1e-9 && w < 0.6 && w > 0.4, `cos(lat) squeeze: expected w≈0.5 h=1, got w=${w.toFixed(2)} h=${h.toFixed(2)}`);

// orientRing enforces the requested winding. `square` as written (CCW: right,
// up, left, down) has positive signed area, so asking for clockwise reverses it.
const cw = orientRing(square, true);
const ccw = orientRing(square, false);
assert.deepEqual(ccw, square, 'an already-CCW ring is left alone when CCW is asked');
assert.deepEqual(cw, square.slice().reverse(), 'a CCW ring is reversed when CW is asked');
assert.deepEqual(orientRing(cw, true), cw, 'orienting an already-CW ring to CW is a no-op');

// removeBacktracks collapses an out-and-back spur but keeps the path connected.
const spur = removeBacktracks([
	[0, 0],
	[0, 1],
	[0, 2], // out along the vertical…
	[0, 1],
	[0, 0], // …and back down over the same road
	[1, 0], // then continue east
]);
assert.deepEqual(spur, [[0, 0], [1, 0]], 'an out-and-back spur is removed, continuity kept');
// A nested spur (a→b→c→b→a) collapses in one call.
assert.deepEqual(
	removeBacktracks([[0, 0], [1, 0], [2, 0], [1, 0], [0, 0]]),
	[[0, 0]],
	'a fully-retraced there-and-back collapses to its start'
);
// A genuine loop encloses area rather than retracing, so it is left intact.
const loop = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
assert.deepEqual(removeBacktracks(loop), loop, 'a real loop is not touched');

// removeLoops drops a lasso: out east, around a block, back near the start.
const lasso = [
	[0, 0],
	[0.001, 0],
	[0.002, 0], // east ~222m
	[0.002, 0.001], // north
	[0.0002, 0.001], // west
	[0.0002, 0], // back down to ~22m from the start — the near-return
	[-0.001, 0], // then continue west
];
const unlassoed = removeLoops(lasso);
assert.ok(unlassoed.length < lasso.length, 'the lasso loop is removed');
assert.deepEqual(unlassoed[0], [0, 0], 'the path still starts where it did');
assert.deepEqual(unlassoed[unlassoed.length - 1], [-0.001, 0], 'and continues past the loop');
assert.ok(pathLength(unlassoed) < pathLength(lasso) / 2, 'the excursion length is gone');
// A tight bend that never returns near itself is left alone.
const bend = [[0, 0], [0.002, 0], [0.004, 0.001], [0.006, 0]];
assert.deepEqual(removeLoops(bend), bend, 'a genuine bend is not cut');

// retracedFraction: an out-and-back reuses its one segment (~50%); a clean loop 0.
assert.ok(Math.abs(retracedFraction([[0, 0], [0.001, 0], [0, 0]]) - 0.5) < 1e-6, 'out-and-back is ~50% retraced');
assert.equal(retracedFraction(square), 0, 'a shape that never repeats a segment is 0% retraced');

// descend: the placement search moves the shape onto a better fit and respects
// the scale bound. Synthetic "router" snaps each waypoint to an integer-degree
// grid (stand-in for roads), so a shape sitting off-grid traces poorly and the
// search should slide it onto the grid, lowering deviation.
{
	const { descend } = await import('../src/lib/bike-route.ts');
	const gridRoute = async (wp) => {
		const coords = wp.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
		return { coords, length: pathLength(coords), ascend: 0, retraced: 0 };
	};
	// A ~0.7°-ish square dropped off the 0.1° grid.
	const ring0 = [
		[0.03, 0.03], [0.73, 0.03], [0.73, 0.73], [0.03, 0.73], [0.03, 0.03],
	];
	const initial = deviation((await gridRoute(resample(ring0, 20000))).coords, resample(ring0, 20000)).mean;
	const res = await descend(ring0, gridRoute, {
		startSpacing: 30000, minSpacing: 15000, maxScale: 0.15, maxEvals: 40,
	});
	assert.ok(res.rounds > 0, 'the search actually moved');
	assert.ok(res.routed && deviation(res.routed.coords, res.waypoints).mean <= initial + 1e-9, 'fit did not get worse');
	assert.ok(res.scale >= 1 - 0.15 - 1e-9 && res.scale <= 1 + 0.15 + 1e-9, 'scale stayed within the bound');
}

// descend with maxScale 0 never scales.
{
	const { descend } = await import('../src/lib/bike-route.ts');
	const flat = async (wp) => ({ coords: wp.map(([x, y]) => [x + 0.001, y]), length: 0, ascend: 0, retraced: 0 });
	const ring0 = [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5], [0, 0]];
	const res = await descend(ring0, flat, { startSpacing: 40000, minSpacing: 20000, maxScale: 0, maxEvals: 20 });
	assert.equal(res.scale, 1, 'maxScale 0 pins the size');
}

// descend recovers when the router refuses a placement (a 400 over water):
// the failed candidate is skipped, the search stays on routable ground and
// returns a result instead of throwing.
{
	const { descend } = await import('../src/lib/bike-route.ts');
	let refusals = 0;
	// Everything east of lng 2.7 is "water" — routing there throws, like a 400.
	const coastRoute = async (wp) => {
		const cx = wp.reduce((s, p) => s + p[0], 0) / wp.length;
		if (cx > 2.7) { refusals++; throw new Error('Router failed (400).'); }
		const coords = wp.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
		return { coords, length: pathLength(coords), ascend: 0, retraced: 0 };
	};
	// A shape on land near the coast, so bold eastward steps land in the water.
	const ring0 = [[2.4, 0], [2.9, 0], [2.9, 0.5], [2.4, 0.5], [2.4, 0]];
	const res = await descend(ring0, coastRoute, {
		startSpacing: 30000, minSpacing: 15000, maxScale: 0.1, maxEvals: 40,
	});
	assert.ok(res && res.routed, 'the search returns a result despite refusals');
	const cx = res.ring.reduce((s, p) => s + p[0], 0) / res.ring.length;
	assert.ok(cx <= 2.7, 'the winning placement stayed on routable ground, not in the water');
	assert.ok(refusals > 0, 'the test actually exercised a router refusal');
}

console.log('bike-route: all checks passed');
