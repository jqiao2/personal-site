// The heatmap's tile grid — the one thing on that page with arithmetic worth
// getting wrong. Checks the square is ~150 ft at the reference latitude, that
// the grid is one world-spanning tessellation (squares meeting edge to edge,
// rows aligned with each other) rather than a per-row invention, that a tile
// counts an activity once rather than once per sample, and that a sparse track
// doesn't leave locked squares in the middle of a road.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/heatmap.test.mjs
import assert from 'node:assert/strict';
import {
	TILE_FEET,
	REF_LAT,
	TILE_BUCKETS,
	tileKey,
	tileBounds,
	tileGroundMeters,
	addTrackTiles,
	tilesToGeoJSON,
} from '../src/lib/heatmap.ts';
import { haversine } from '../src/lib/route-shape.ts';

const TILE_M = TILE_FEET * 0.3048;

// 1. ~150 ft on a side at the reference latitude, and square on the ground at
//    every latitude (that is what a mercator cell buys).
for (const lat of [0.5, REF_LAT, 64.1]) {
	const [[w, s], [e, n]] = tileBounds(tileKey(lat, -73.98));
	const width = haversine([s, w], [s, e]);
	const height = haversine([s, w], [n, w]);
	assert.ok(Math.abs(width - height) / width < 0.02, `tile at ${lat}° isn't square: ${width} × ${height}`);
	assert.ok(
		Math.abs(width - tileGroundMeters(lat)) / width < 0.02,
		`tileGroundMeters disagrees with the drawn tile at ${lat}°`,
	);
}
{
	const [[w, s], [e]] = tileBounds(tileKey(REF_LAT, -73.98));
	const width = haversine([s, w], [s, e]);
	assert.ok(Math.abs(width - TILE_M) / TILE_M < 0.02, `tile at REF_LAT is ${width.toFixed(1)}m, want ${TILE_M}m`);
}

// 2. ONE GLOBAL GRID. Neighbouring tiles share an edge exactly, and a tile
//    1,000 km north shares its column's east/west edges — a fog-of-war board
//    only reads as one if the squares tessellate.
{
	const [[w], [e, n]] = tileBounds(tileKey(REF_LAT, -73.98));
	const east = tileBounds(tileKey(REF_LAT, e + 1e-9));
	const north = tileBounds(tileKey(n + 1e-9, -73.98));
	assert.equal(east[0][0], e, 'the next tile east must start where this one ends');
	assert.equal(north[0][1], n, 'the next tile north must start where this one ends');
	assert.equal(north[0][0], w, 'columns must line up between rows');
	assert.equal(north[1][0], e, 'columns must line up between rows');
}

// 3. A tile the same activity crosses 500 times still counts 1; a second
//    activity over the same ground makes it 2.
{
	const jitter = Array.from({ length: 500 }, (_, i) => [REF_LAT + i * 1e-7, -73.98 + i * 1e-7]);
	const counts = new Map();
	addTrackTiles(jitter, counts);
	assert.equal(counts.size, 1, 'samples inside one tile are one tile');
	assert.equal([...counts.values()][0], 1, 'and one visit');
	addTrackTiles(jitter, counts);
	assert.equal([...counts.values()][0], 2, 'a second activity increments it');
}

// 4. Two points 1 km apart are a kilometre ridden, not two dots — the gap is
//    unlocked square by square, with no holes, at both latitude extremes the
//    step has to adapt to.
for (const lat of [REF_LAT, 64.1]) {
	const counts = new Map();
	const north = 1000 / 111_320;
	addTrackTiles(
		[
			[lat, -73.98],
			[lat + north, -73.98],
		],
		counts,
	);
	const expected = Math.floor(1000 / tileGroundMeters(lat));
	assert.ok(counts.size >= expected, `at ${lat}°: expected ~${expected} tiles, got ${counts.size}`);
	const rows = [...counts.keys()].map((k) => Number(k.split(':')[1])).sort((a, b) => a - b);
	for (let i = 1; i < rows.length; i++) assert.equal(rows[i] - rows[i - 1], 1, `hole in the track at ${lat}°`);
}

// 5. Rectangles come out closed, in the bucket their count belongs to.
{
	const counts = new Map([
		[tileKey(REF_LAT, -73.98), 1],
		[tileKey(REF_LAT + 0.01, -73.98), 3],
		[tileKey(REF_LAT + 0.02, -73.98), 40],
	]);
	const fc = tilesToGeoJSON(counts);
	assert.equal(fc.features.length, TILE_BUCKETS.length, 'one feature per bucket');
	assert.deepEqual(
		fc.features.map((f) => f.properties.tiles),
		[1, 1, 0, 1],
		'1 → first bucket, 3 → second, 40 → last',
	);
	const ring = fc.features[0].geometry.coordinates[0][0];
	assert.equal(ring.length, 5);
	assert.deepEqual(ring[0], ring[4], 'ring must close');
}

console.log('heatmap tiles: ok');
