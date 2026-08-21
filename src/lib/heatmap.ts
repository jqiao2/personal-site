// The heatmap's tile grid — /activities/heatmap's second view.
//
// WHY NOT SLIPPY TILES. The obvious grid is a web-mercator tile at some fixed
// zoom, which is what Strava's "squares" use. No integer zoom lands anywhere
// near 150 ft (z19 is ~57 ft at 40°N, z18 ~115 ft, z17 ~230 ft), and mercator
// tiles are only square in projected space — a "150 ft" tile would be 150 ft
// somewhere and something else everywhere else. So the grid is defined in
// ground metres directly: rows of constant latitude height, and inside each
// row a column width that divides that row's own circle of latitude. Tiles
// stay ~square on the ground at every latitude, which is the property the
// feature is actually about ("I have covered this much ground").
//
// The cost of that choice is that columns don't line up between rows the way
// mercator tiles do. Nothing here needs them to: a tile is only ever drawn as
// its own rectangle and counted in its own bucket.
export const TILE_FEET = 150;

const METERS_PER_FOOT = 0.3048;
const TILE_M = TILE_FEET * METERS_PER_FOOT; // 45.72 m
/** Metres per degree of latitude — a sphere is close enough at 45 m. */
const M_PER_DEG_LAT = 111_320;
const DEG_LAT = TILE_M / M_PER_DEG_LAT;

/** Cosine of the row's latitude, floored so a track near the pole yields a
 * finite column width instead of dividing by zero. */
function cosLat(row: number): number {
	const lat = (row + 0.5) * DEG_LAT;
	return Math.max(0.01, Math.cos((lat * Math.PI) / 180));
}

/** Degrees of longitude one tile spans in `row`. */
function degLng(row: number): number {
	return DEG_LAT / cosLat(row);
}

/** The tile containing a point, as "row:col". Row is a global latitude band;
 * col indexes that band's own division of the 360°. */
export function tileKey(lat: number, lng: number): string {
	const row = Math.floor(lat / DEG_LAT);
	const col = Math.floor(lng / degLng(row));
	return `${row}:${col}`;
}

/** A tile's corners as [[w,s],[e,n]] — what a GeoJSON rectangle is built from. */
export function tileBounds(key: string): [[number, number], [number, number]] {
	const [row, col] = key.split(':').map(Number);
	const dLng = degLng(row);
	return [
		[col * dLng, row * DEG_LAT],
		[(col + 1) * dLng, (row + 1) * DEG_LAT],
	];
}

/**
 * Every tile a track passes through, added to `counts` once per track — so a
 * tile's number is "how many activities crossed it", not "how many GPS samples
 * landed in it" (which would just measure how slowly you went through it).
 *
 * Samples along each segment at half a tile so a gap between two recorded
 * points — a tunnel, a paused watch, a 30 mph descent at 1 Hz — doesn't leave
 * holes in the middle of a line the athlete plainly rode.
 */
export function addTrackTiles(points: [number, number][], counts: Map<string, number>): void {
	const seen = new Set<string>();
	for (let i = 0; i < points.length; i++) {
		const [lat, lng] = points[i];
		seen.add(tileKey(lat, lng));
		const next = points[i + 1];
		if (!next) continue;
		const [lat2, lng2] = next;
		// Metres between the two points, flat-earth over a segment this short.
		const dy = (lat2 - lat) * M_PER_DEG_LAT;
		const dx = (lng2 - lng) * M_PER_DEG_LAT * cosLat(Math.floor(lat / DEG_LAT));
		const steps = Math.floor(Math.hypot(dx, dy) / (TILE_M / 2));
		for (let s = 1; s < steps; s++) {
			const t = s / steps;
			seen.add(tileKey(lat + (lat2 - lat) * t, lng + (lng2 - lng) * t));
		}
	}
	for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The bucket boundaries the tile fill ramps over: touched once, a couple of
 * times, a habit, a rut. Counts are heavily skewed (one commute route can be
 * ridden hundreds of times while most ground is crossed once), so fixed
 * thresholds read better than a linear ramp to the maximum, which would push
 * everything but the commute into the palest colour. */
export const TILE_BUCKETS = [1, 2, 4, 10] as const;

export interface TileCollection {
	type: 'FeatureCollection';
	features: {
		type: 'Feature';
		geometry: { type: 'MultiPolygon'; coordinates: [number, number][][][] };
		properties: { bucket: number; min: number; tiles: number };
	}[];
}

/** ~11 cm — enough for a 45 m tile, and it keeps the payload handed to
 *  MapLibre from being mostly float noise. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The counted tiles as drawable rectangles, grouped into one MultiPolygon per
 * bucket of TILE_BUCKETS.
 *
 * ONE FEATURE PER BUCKET, NOT ONE PER TILE. A few years of riding quantises to
 * ~185,000 tiles; as individual features that is a GeoJSON source MapLibre
 * spends hundreds of megabytes and several seconds on. As four MultiPolygons
 * it is the same rectangles with none of the per-feature overhead, and the
 * fill colour still varies — it just reads the bucket off the feature instead
 * of an exact count off each tile, which is all the eye was getting from a
 * ramp anyway.
 */
export function tilesToGeoJSON(counts: Map<string, number>): TileCollection {
	/** One MultiPolygon's worth of rectangles per bucket. */
	type MultiPolygon = TileCollection['features'][number]['geometry']['coordinates'];
	const byBucket: MultiPolygon[] = TILE_BUCKETS.map(() => []);
	for (const [key, count] of counts) {
		let bucket = 0;
		while (bucket + 1 < TILE_BUCKETS.length && count >= TILE_BUCKETS[bucket + 1]) bucket++;
		const [[w, s], [e, n]] = tileBounds(key);
		const ring: [number, number][] = [
			[round(w), round(s)],
			[round(e), round(s)],
			[round(e), round(n)],
			[round(w), round(n)],
			[round(w), round(s)],
		];
		byBucket[bucket].push([ring]);
	}
	return {
		type: 'FeatureCollection',
		features: byBucket.map((polygons, bucket) => ({
			type: 'Feature' as const,
			geometry: { type: 'MultiPolygon' as const, coordinates: polygons },
			properties: { bucket, min: TILE_BUCKETS[bucket], tiles: polygons.length },
		})),
	};
}
