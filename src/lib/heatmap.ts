// The heatmap's tile grid — /activities/heatmap's second view.
//
// ONE GRID, THE WHOLE WORLD, FIXED FOREVER. The tiles are a board an activity
// unlocks squares on, so the board cannot move: a square has to mean the same
// square next year, from a different city, on a different device. That rules
// out anything computed from the data (a grid anchored on the first activity,
// or on the collection's bounding box) — import one old ride from another
// continent and every previously-unlocked square would shift.
//
// So the grid is squares of a constant size in Web Mercator, indexed from the
// projection's own origin. Two consequences worth being explicit about:
//
//   - Columns line up across rows and rows line up across the globe, which is
//     what makes the fog-of-war reading legible — squares tessellate instead
//     of jittering row to row.
//   - A mercator square is only one true size at one latitude. TILE_FEET is
//     the size at REF_LAT; the ground square shrinks as cos(lat) away from it
//     (~197 ft at the equator, ~130 ft at 50°N). Any grid that both tiles the
//     world neatly and stays exactly 150 ft everywhere doesn't exist, so this
//     is the trade: neat everywhere, exact where the riding happens.
//
// The alternative — rows that each divide their own circle of latitude — keeps
// the ground size exact and gives up the alignment. That is the wrong half to
// keep for a fog-of-war map, where the whole point is that squares fit
// together.
export const TILE_FEET = 150;

/** The latitude TILE_FEET is exact at — New York, where most of the log is.
 * ponytail: a constant, not a setting; if the riding ever moves continents,
 * change the number, don't build a preference for it. */
export const REF_LAT = 40.7;

const METERS_PER_FOOT = 0.3048;
const TILE_M = TILE_FEET * METERS_PER_FOOT; // 45.72 m on the ground at REF_LAT
const EARTH_RADIUS_M = 6378137; // WGS84 equatorial radius — matches EPSG:3857
const MAX_LAT = 85.05112878; // mercator's own cutoff

/** The cell's side in Web Mercator metres. Mercator stretches by 1/cos(lat),
 * so a cell that measures TILE_M on the ground at REF_LAT measures this in the
 * projection — everywhere. */
const CELL = TILE_M / Math.cos((REF_LAT * Math.PI) / 180);

function toMercator(lat: number, lng: number): [number, number] {
	const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
	return [
		(lng * Math.PI * EARTH_RADIUS_M) / 180,
		EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)),
	];
}

function fromMercator(x: number, y: number): [number, number] {
	return [
		(2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI),
		(x * 180) / (Math.PI * EARTH_RADIUS_M),
	];
}

/** The tile containing a point, as "col:row" — indices into the one global
 * grid, so the same ground always yields the same key. */
export function tileKey(lat: number, lng: number): string {
	const [x, y] = toMercator(lat, lng);
	return `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
}

/** A tile's corners as [[w,s],[e,n]] in degrees. A mercator square has edges
 * of constant x and constant y, so it is still a lat/lng rectangle — just a
 * slightly shorter one the further north it sits. */
export function tileBounds(key: string): [[number, number], [number, number]] {
	const [col, row] = key.split(':').map(Number);
	const [s, w] = fromMercator(col * CELL, row * CELL);
	const [n, e] = fromMercator((col + 1) * CELL, (row + 1) * CELL);
	return [
		[w, s],
		[e, n],
	];
}

/** The ground size of a tile at a given latitude, in metres — TILE_M at
 * REF_LAT by construction, and what the sampling step below is derived from. */
export function tileGroundMeters(lat: number): number {
	return CELL * Math.cos((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
}

const M_PER_DEG_LAT = 111_320;

/**
 * Every tile a track unlocks, added to `counts` once per track — so a tile's
 * number is "how many activities crossed it", not "how many GPS samples landed
 * in it" (which would only measure how slowly you went through it). With the
 * heatmap off the page reads the same map as a boolean: present or absent.
 *
 * Samples along each segment at half a tile so a gap between two recorded
 * points — a tunnel, a paused watch, a 30 mph descent at 1 Hz — doesn't leave
 * a locked square in the middle of a road plainly ridden.
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
		const cosLat = Math.cos((lat * Math.PI) / 180);
		const dy = (lat2 - lat) * M_PER_DEG_LAT;
		const dx = (lng2 - lng) * M_PER_DEG_LAT * cosLat;
		// Half a tile *at this latitude* — the ground square gets smaller the
		// further from REF_LAT you are, and a fixed step would start skipping
		// squares up north.
		const step = Math.max(1, tileGroundMeters(lat) / 2);
		const steps = Math.floor(Math.hypot(dx, dy) / step);
		for (let s = 1; s < steps; s++) {
			const t = s / steps;
			seen.add(tileKey(lat + (lat2 - lat) * t, lng + (lng2 - lng) * t));
		}
	}
	for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The bucket boundaries the heatmap fill ramps over: unlocked once, a couple
 * of times, a habit, a rut. Counts are heavily skewed (one commute can be
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
 * The unlocked tiles as drawable rectangles, grouped into one MultiPolygon per
 * bucket of TILE_BUCKETS. With the heatmap off the page paints every bucket
 * the same colour, which is the boolean reading; with it on, the bucket picks
 * the shade.
 *
 * ONE FEATURE PER BUCKET, NOT ONE PER TILE. A few years of riding unlocks
 * ~185,000 tiles; as individual features that is a GeoJSON source MapLibre
 * spends hundreds of megabytes and several seconds on. As four MultiPolygons
 * it is the same rectangles with none of the per-feature overhead, and the
 * fill still varies — it just reads a bucket off the feature instead of an
 * exact count off each tile, which is all the eye was getting from a ramp
 * anyway.
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

// --- hexes -----------------------------------------------------------------
//
// The same board, tessellated with hexagons instead of squares — the beehive
// reading of the identical data. Everything above still applies: one global
// grid, indexed from the mercator origin, fixed forever, so a cell means the
// same ground on every device and every year.
//
// A hexagon is sized by area, not by side, so a hex covers the same ground as
// a TILE_FEET square and the two views read at the same resolution. Pointy-top
// axial layout (rows offset by half a hex), which is what gives the honeycomb
// its stagger.
//
// ponytail: the tile functions above are kept as-is, not refactored into a
// shared "cell grid" abstraction — two concrete grids are less code than one
// parameterised one, and the tiles are the fallback if hexes don't stick.

/** Circumradius of a hex whose area equals CELL². area = (3√3/2)R². */
const HEX_R = CELL / Math.sqrt((3 * Math.sqrt(3)) / 2);
const SQRT3 = Math.sqrt(3);

/** Axial rounding — the cube-round from redblobgames, in axial terms. */
function axialRound(q: number, r: number): [number, number] {
	const s = -q - r;
	let rq = Math.round(q);
	let rr = Math.round(r);
	const rs = Math.round(s);
	const dq = Math.abs(rq - q);
	const dr = Math.abs(rr - r);
	const ds = Math.abs(rs - s);
	if (dq > dr && dq > ds) rq = -rr - rs;
	else if (dr > ds) rr = -rq - rs;
	return [rq, rr];
}

/** The hex containing a point, as "q:r" in the one global axial grid. */
export function hexKey(lat: number, lng: number): string {
	const [x, y] = toMercator(lat, lng);
	const [q, r] = axialRound(((SQRT3 / 3) * x - y / 3) / HEX_R, (2 / 3) * y / HEX_R);
	return `${q}:${r}`;
}

/** A hex's six corners in degrees, closed (first point repeated). */
export function hexRing(key: string): [number, number][] {
	const [q, r] = key.split(':').map(Number);
	const cx = HEX_R * SQRT3 * (q + r / 2);
	const cy = HEX_R * (3 / 2) * r;
	const ring: [number, number][] = [];
	for (let i = 0; i < 6; i++) {
		const a = (Math.PI / 180) * (60 * i - 30);
		const [lat, lng] = fromMercator(cx + HEX_R * Math.cos(a), cy + HEX_R * Math.sin(a));
		ring.push([round(lng), round(lat)]);
	}
	ring.push(ring[0]);
	return ring;
}

/** addTrackTiles, on the hex grid. Same once-per-track counting, same
 *  half-a-cell sampling so a GPS gap doesn't leave a hole in a ridden road. */
export function addTrackHexes(points: [number, number][], counts: Map<string, number>): void {
	const seen = new Set<string>();
	for (let i = 0; i < points.length; i++) {
		const [lat, lng] = points[i];
		seen.add(hexKey(lat, lng));
		const next = points[i + 1];
		if (!next) continue;
		const [lat2, lng2] = next;
		const cosLat = Math.cos((lat * Math.PI) / 180);
		const dy = (lat2 - lat) * M_PER_DEG_LAT;
		const dx = (lng2 - lng) * M_PER_DEG_LAT * cosLat;
		const step = Math.max(1, tileGroundMeters(lat) / 2);
		const steps = Math.floor(Math.hypot(dx, dy) / step);
		for (let s = 1; s < steps; s++) {
			const t = s / steps;
			seen.add(hexKey(lat + (lat2 - lat) * t, lng + (lng2 - lng) * t));
		}
	}
	for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** tilesToGeoJSON, on the hex grid — one MultiPolygon per TILE_BUCKETS bucket,
 *  for the same reason (185k features is a source MapLibre chokes on). */
export function hexesToGeoJSON(counts: Map<string, number>): TileCollection {
	type MultiPolygon = TileCollection['features'][number]['geometry']['coordinates'];
	const byBucket: MultiPolygon[] = TILE_BUCKETS.map(() => []);
	for (const [key, count] of counts) {
		let bucket = 0;
		while (bucket + 1 < TILE_BUCKETS.length && count >= TILE_BUCKETS[bucket + 1]) bucket++;
		byBucket[bucket].push([hexRing(key)]);
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
