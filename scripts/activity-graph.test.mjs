// The runnable check on buildGraphData — the one bit of real logic behind the
// interactive profile graph: every array is sampled at the SAME indices (so the
// scrub readout and the map marker never desync), series with nothing to draw
// are dropped, and an activity with no axis is rejected.
//
//   node --import ./scripts/ts-hook.mjs scripts/activity-graph.test.mjs
import assert from 'node:assert/strict';
import { buildGraphData, GRAPH_N } from '../src/lib/activity-graph.ts';

// A small activity, no downsampling (len < GRAPH_N): everything passes through.
const small = buildGraphData({
	time_s: [10, 11, 12, 13],
	distance_m: [0, 5, 12, 20],
	altitude_m: [100, 101, 102, 103],
	heartrate: [120, 130, 140, 150],
	power_w: null,
	speed_ms: [5, 5.5, 6, 6.5],
	latlng: [
		[40.1, -74.1],
		[40.2, -74.2],
		[40.3, -74.3],
		[40.4, -74.4],
	],
});
assert.ok(small, 'a normal activity produces a graph');
assert.equal(small.n, 4);
// Axes read from zero.
assert.deepEqual(small.t, [0, 1, 2, 3]);
assert.deepEqual(small.d, [0, 5, 12, 20]);
// Only the three present series, no power.
assert.deepEqual(
	small.series.map((s) => s.key),
	['elevation', 'heartrate', 'speed'],
);
// Every parallel array is the same length — the scrub invariant.
for (const arr of [small.t, small.d, small.lat, small.lng, ...small.series.map((s) => s.values)]) {
	assert.equal(arr.length, small.n, 'all sampled arrays share the index count');
}
// Elevation converted metres→feet and rounded.
assert.equal(small.series[0].values[0], Math.round(100 * 3.28084));
// Speed converted m/s→mph, one decimal.
assert.equal(small.series.find((s) => s.key === 'speed').values[0], Number((5 * 2.236936).toFixed(1)));

// Downsampling keeps endpoints and the shared index count.
const n = GRAPH_N * 3;
const big = buildGraphData({
	time_s: Array.from({ length: n }, (_, i) => i),
	distance_m: Array.from({ length: n }, (_, i) => i * 2),
	altitude_m: Array.from({ length: n }, (_, i) => 100 + i),
	latlng: Array.from({ length: n }, (_, i) => [40 + i / n, -74 - i / n]),
});
assert.equal(big.n, GRAPH_N, 'downsampled to GRAPH_N');
assert.equal(big.t[0], 0);
assert.equal(big.t[big.n - 1], n - 1, 'last sample is the real end, not a stride short');
assert.equal(big.d[big.n - 1], (n - 1) * 2);

// Missing samples become null (line breaks), not zeros, and don't shift indices.
const gappy = buildGraphData({
	time_s: [0, 1, 2, 3],
	heartrate: [120, NaN, null, 150],
});
assert.deepEqual(gappy.series[0].values, [120, null, null, 150]);
assert.equal(gappy.lat, null, 'no latlng → no marker coordinates');

// Rejections: nothing plottable, or no axis at all.
assert.equal(buildGraphData(null), null);
assert.equal(buildGraphData({ time_s: [1, 2, 3] }), null, 'axis but no series → null');
assert.equal(buildGraphData({ altitude_m: [1, 2, 3] }), null, 'series but no axis → null');
assert.equal(buildGraphData({ time_s: [1], altitude_m: [5] }), null, 'a single sample is not a line');

console.log('activity-graph: all assertions passed');
