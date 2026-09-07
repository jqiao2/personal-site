// The outline-tracing geometry, checked without touching the network.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/bike-route.test.mjs
import assert from 'node:assert/strict';
import { outerRing, resample, pathLength, deviation, toGPX, haversine } from '../src/lib/bike-route.ts';

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

console.log('bike-route: all checks passed');
