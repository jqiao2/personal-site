// The heatmap's tile grid — the one thing on that page with arithmetic worth
// getting wrong. Checks the tile really is ~150 ft on both sides (at three
// latitudes, since the grid's whole point is staying square as cos(lat)
// changes), that a tile counts an activity once rather than once per sample,
// and that a sparse track doesn't leave holes.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/heatmap.test.mjs
import assert from 'node:assert/strict';
import { TILE_FEET, TILE_BUCKETS, tileKey, tileBounds, addTrackTiles, tilesToGeoJSON } from '../src/lib/heatmap.ts';
import { haversine } from '../src/lib/route-shape.ts';

const TILE_M = TILE_FEET * 0.3048;

// 1. ~150 ft on a side, anywhere.
for (const lat of [0.5, 40.7, 64.1]) {
	const [[w, s], [e, n]] = tileBounds(tileKey(lat, -73.98));
	const width = haversine([s, w], [s, e]);
	const height = haversine([s, w], [n, w]);
	assert.ok(Math.abs(width - TILE_M) / TILE_M < 0.02, `tile width at ${lat}°: ${width.toFixed(1)}m`);
	assert.ok(Math.abs(height - TILE_M) / TILE_M < 0.02, `tile height at ${lat}°: ${height.toFixed(1)}m`);
}

// 2. A tile the same activity crosses 500 times still counts 1; a second
//    activity over the same ground makes it 2.
{
	const jitter = Array.from({ length: 500 }, (_, i) => [40.7 + i * 1e-7, -73.98 + i * 1e-7]);
	const counts = new Map();
	addTrackTiles(jitter, counts);
	assert.equal(counts.size, 1, 'samples inside one tile are one tile');
	assert.equal([...counts.values()][0], 1, 'and one visit');
	addTrackTiles(jitter, counts);
	assert.equal([...counts.values()][0], 2, 'a second activity increments it');
}

// 3. Two points 1 km apart are a kilometre ridden, not two dots — the gap is
//    filled at better than one tile per tile-length.
{
	const counts = new Map();
	const north = 1000 / 111_320;
	addTrackTiles([[40.7, -73.98], [40.7 + north, -73.98]], counts);
	assert.ok(counts.size >= Math.floor(1000 / TILE_M), `expected ~${Math.floor(1000 / TILE_M)} tiles, got ${counts.size}`);
	// Contiguous: every row between the endpoints is present exactly once.
	const rows = [...counts.keys()].map((k) => Number(k.split(':')[0])).sort((a, b) => a - b);
	for (let i = 1; i < rows.length; i++) assert.equal(rows[i] - rows[i - 1], 1, 'hole in the track');
}

// 4. Rectangles come out closed, in the bucket their count belongs to.
{
	const counts = new Map([
		[tileKey(40.7, -73.98), 1],
		[tileKey(40.71, -73.98), 3],
		[tileKey(40.72, -73.98), 40],
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
