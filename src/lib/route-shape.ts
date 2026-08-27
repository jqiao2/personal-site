// Route geometry for the "route poster" — §7 of ACTIVITIES.md.
//
// WHY THE SHAPE IS BAKED TO AN SVG PATH AT INGEST, NOT DRAWN FROM THE
// POLYLINE ON THE CLIENT. The landing page and the month page are forty route
// thumbnails at a time, 60px on a side. A live map for forty tiles means forty
// map instances, forty tile-layer network round-trips (or one shared instance
// doing forty fitBounds calls, which is still forty reflows), and a
// JavaScript dependency for something that is, at that size, a doodle. None
// of that buys anything: a 60px thumbnail has roughly 60 addressable pixels
// per axis, so it cannot resolve more than the ~200-point ceiling this file
// simplifies down to regardless of how much fidelity the source GPS track
// actually has. So the expensive part — decode, project, simplify, fit — is
// done once, at import time, in this pure function, and the row stores a
// plain `M x y L x y …` string. The card that draws it is `<path d={route_path}/>`
// and nothing else: no map tiles, no JS, no per-tile network cost, and it
// still renders in a browser with JavaScript disabled or in an exported PNG.
// The interactive map on the detail page is a different, one-at-a-time
// problem and reads the original `polyline` column instead — this file is
// only for the many-at-once view.
//
// WHY WEB MERCATOR AND NOT A RAW LAT/LNG SCATTER. Plotting (lng, lat) directly
// squashes east-west distance by cos(latitude) — harmless near the equator,
// visibly wrong at the latitudes this athlete actually rides and hikes at
// (Pacific Northwest, high 40s). A ride shaped like a rounded rectangle would
// come out visibly narrower than it should. Mercator is the wrong projection
// for measuring area, but it is the *right* one for this: it's conformal, so
// a locally-recorded track's shape (angles, relative proportions) survives
// projection undistorted, which is all a thumbnail needs to look correct.
//
// WHY RAMER–DOUGLAS–PEUCKER AND NOT NAIVE DECIMATION (every Nth point). RDP
// keeps points in proportion to how much they bend the line and throws away
// points on a straight stretch, so a ride with one tight switchback and five
// miles of straight road keeps the switchback's shape recognisable and
// collapses the straight into two points. Every-Nth-point decimation has no
// opinion about shape at all — it can erase the one hairpin that made the
// route recognisable while keeping fifty near-collinear points along the
// straight. RDP is the one simplification algorithm whose output is still
// describable as "the same route, fewer points" rather than "a resampling of
// the route."
//
// PRECISION-5 POLYLINE. Google's encoded polyline format (also what Strava's
// API and GPX-derived exports use) is precision-5 by convention — 1e-5
// degrees, about 1.1m at these latitudes — which is already coarser than GPS
// accuracy, so nothing is lost keeping it at that precision throughout.

// ---------------------------------------------------------------------------
// Encoded polyline (Google's algorithm, precision 5)
// ---------------------------------------------------------------------------

const POLYLINE_PRECISION = 1e5;

interface Cursor {
	i: number;
}

/** Decodes a Google-encoded polyline string to `[lat, lng]` pairs. Threaded
 *  through a small cursor object rather than a closure-captured index, since
 *  each coordinate consumes a variable number of bytes and the two reads per
 *  point (lat, then lng) need to share one advancing position. */
export function decodePolyline(encoded: string): [number, number][] {
	const points: [number, number][] = [];
	const cur: Cursor = { i: 0 };
	let lat = 0;
	let lng = 0;
	const len = encoded.length;

	while (cur.i < len) {
		lat += readSignedValue(encoded, cur);
		lng += readSignedValue(encoded, cur);
		points.push([lat / POLYLINE_PRECISION, lng / POLYLINE_PRECISION]);
	}
	return points;
}

/** Reads one varint-encoded, zigzag-signed delta starting at `cur.i`,
 *  advancing the cursor past it. This is the core of the polyline format:
 *  each coordinate delta is stored 5 bits at a time, offset by 63 and with
 *  the continuation bit set on every byte but the last. */
function readSignedValue(encoded: string, cur: Cursor): number {
	let result = 0;
	let shift = 0;
	let byte: number;
	do {
		byte = encoded.charCodeAt(cur.i++) - 63;
		result |= (byte & 0x1f) << shift;
		shift += 5;
	} while (byte >= 0x20);
	// Zigzag decode: odd result means negative.
	return result & 1 ? ~(result >> 1) : result >> 1;
}

/** Encodes `[lat, lng]` pairs to a Google-encoded polyline string, precision 5.
 *  Inverse of `decodePolyline`; `decode(encode(pts))` round-trips to within
 *  the format's own precision (1e-5 degrees). */
export function encodePolyline(points: [number, number][]): string {
	let out = '';
	let prevLat = 0;
	let prevLng = 0;
	for (const [lat, lng] of points) {
		const lat5 = Math.round(lat * POLYLINE_PRECISION);
		const lng5 = Math.round(lng * POLYLINE_PRECISION);
		out += encodeSignedValue(lat5 - prevLat);
		out += encodeSignedValue(lng5 - prevLng);
		prevLat = lat5;
		prevLng = lng5;
	}
	return out;
}

function encodeSignedValue(value: number): string {
	// Zigzag encode, then the same 5-bits-plus-continuation-bit scheme as the
	// reader above, in reverse.
	let v = value < 0 ? ~(value << 1) : value << 1;
	let out = '';
	while (v >= 0x20) {
		out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
		v >>= 5;
	}
	out += String.fromCharCode(v + 63);
	return out;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6378137; // WGS84 equatorial radius — matches Web Mercator (EPSG:3857)

/** Web Mercator projection, in metres (EPSG:3857-style, unscaled). Used only
 *  for shape (see header comment) — never for area or for anything that
 *  needs true distance, which is what `haversine` is for instead. */
export function mercator(lat: number, lng: number): [number, number] {
	const x = (lng * Math.PI * EARTH_RADIUS_M) / 180;
	const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
	const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
	return [x, y];
}

// ---------------------------------------------------------------------------
// Simplification — Ramer–Douglas–Peucker
// ---------------------------------------------------------------------------

function perpendicularDistanceSq(p: [number, number], a: [number, number], b: [number, number]): number {
	const [px, py] = p;
	const [ax, ay] = a;
	const [bx, by] = b;
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) {
		const ddx = px - ax;
		const ddy = py - ay;
		return ddx * ddx + ddy * ddy;
	}
	// Distance from p to the infinite line through a,b via the cross product
	// magnitude — cheaper than projecting onto the segment and doesn't need a
	// square root since every caller only compares distances.
	const cross = dx * (ay - py) - (ax - px) * dy;
	return (cross * cross) / lenSq;
}

/**
 * Ramer–Douglas–Peucker line simplification. `tolerance` is in the same
 * units as `points` (metres, when fed projected coordinates) — a point is
 * kept only if it sits farther than `tolerance` from the straight line
 * connecting the points that survived on either side of it. Recursive by
 * nature; implemented with an explicit stack so a very long, very straight
 * track (thousands of points, nothing to simplify) can't blow the call stack.
 */
export function simplify(points: [number, number][], tolerance: number): [number, number][] {
	const n = points.length;
	if (n < 3) return points.slice();

	const toleranceSq = tolerance * tolerance;
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;

	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [start, end] = stack.pop()!;
		if (end - start < 2) continue;
		let maxDistSq = -1;
		let maxIndex = -1;
		for (let i = start + 1; i < end; i++) {
			const d = perpendicularDistanceSq(points[i], points[start], points[end]);
			if (d > maxDistSq) {
				maxDistSq = d;
				maxIndex = i;
			}
		}
		if (maxDistSq > toleranceSq) {
			keep[maxIndex] = 1;
			stack.push([start, maxIndex], [maxIndex, end]);
		}
	}

	const out: [number, number][] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
	return out;
}

/**
 * Simplifies to at most `maxPoints`, widening the tolerance geometrically
 * until the result fits. RDP's tolerance doesn't map linearly (or even
 * monotonically-predictably) to output point count, and computing the exact
 * tolerance that yields exactly N points would mean re-running the whole
 * algorithm under a binary search — overkill for a one-time ingest-time cost
 * where "at most maxPoints, good shape" beats "exactly maxPoints, arbitrary
 * cost". Ten doublings takes a degenerate GPS-jitter track (thousands of
 * near-duplicate points, tiny natural tolerance) from ~0.5m to ~500m, which
 * has always been enough in practice; if it isn't, the loop's final result is
 * still returned rather than looping forever.
 */
function simplifyToLimit(points: [number, number][], maxPoints: number): [number, number][] {
	if (points.length <= maxPoints) return points;
	let tolerance = 0.5; // metres — a reasonable starting guess for GPS jitter
	let result = points;
	for (let i = 0; i < 20; i++) {
		result = simplify(points, tolerance);
		if (result.length <= maxPoints) return result;
		tolerance *= 1.6;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** Great-circle distance between two `[lat, lng]` points, in metres. This is
 *  the one place true distance matters (route length, dedupe's 200m
 *  start-point check) — everything drawn on screen goes through `mercator`
 *  instead, which is shape-preserving but not distance-preserving. */
export function haversine(a: [number, number], b: [number, number]): number {
	const [lat1, lng1] = a;
	const [lat2, lng2] = b;
	const toRad = Math.PI / 180;
	const dLat = (lat2 - lat1) * toRad;
	const dLng = (lng2 - lng1) * toRad;
	const s =
		Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total length of a `[lat, lng]` track, summing `haversine` over consecutive
 *  points. */
export function pathLength(points: [number, number][]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
	return total;
}

/**
 * A single step between consecutive samples longer than this is a break in the
 * recording, not distance covered — a paused watch resumed somewhere else, or a
 * long GPS blackout. The stored tracks are ~1 Hz, so a "step" is roughly one
 * second of travel: real movement tops out around 30 m (a fast descent), and
 * the collection's 99.9th-percentile step is 27 m, while a genuine pause leaps
 * hundreds of metres to kilometres (activity 2086 jumps 12.9 km when a ride is
 * stopped at 125th St and restarted in the Bronx). 200 m is the clean divide —
 * at 1 Hz that is >700 km/h, which nothing here does.
 */
export const GPS_GAP_M = 200;

/**
 * Splits a `[lat, lng]` track into continuous pieces, cutting wherever one step
 * exceeds `maxStepM` — the seam a pause-and-relocate (or a long signal loss)
 * leaves in an otherwise ~1 Hz track. A track with no such step comes back as a
 * single piece; an empty track as `[]`. Every returned piece has at least one
 * point. Used to keep the interpolated line between two points from being drawn
 * across ground that was never actually covered (heatmap tiles, the detail
 * map's route line).
 */
export function splitOnGaps(points: [number, number][], maxStepM = GPS_GAP_M): [number, number][][] {
	if (points.length === 0) return [];
	const pieces: [number, number][][] = [];
	let cur: [number, number][] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		if (haversine(points[i - 1], points[i]) > maxStepM) {
			pieces.push(cur);
			cur = [];
		}
		cur.push(points[i]);
	}
	pieces.push(cur);
	return pieces;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface Bounds {
	w: number;
	s: number;
	e: number;
	n: number;
}

/** Lat/lng bounding box of a track, or `null` for an empty track — matches
 *  the `bbox_w/s/e/n` columns on `activities`. */
export function bounds(points: [number, number][]): Bounds | null {
	if (points.length === 0) return null;
	let w = Infinity;
	let s = Infinity;
	let e = -Infinity;
	let n = -Infinity;
	for (const [lat, lng] of points) {
		if (lng < w) w = lng;
		if (lng > e) e = lng;
		if (lat < s) s = lat;
		if (lat > n) n = lat;
	}
	return { w, s, e, n };
}

// ---------------------------------------------------------------------------
// The §7 pipeline
// ---------------------------------------------------------------------------

export interface RoutePathOptions {
	/** Simplify to at most this many points before emitting the path. Default 200 — §7. */
	maxPoints?: number;
	/** Padding, in viewBox units, on all four sides. Default 6 — §7. */
	padding?: number;
	/** Side length of the square viewBox. Default 100 (viewBox "0 0 100 100" — §7). */
	viewBoxSize?: number;
}

/**
 * The full §7 pipeline: project to Web Mercator, simplify to at most
 * `maxPoints`, fit to a square viewBox preserving aspect ratio, centre it
 * with padding, and emit an `M x y L x y …` path string at 1 decimal place.
 *
 * Returns `null` for fewer than 2 points, and also for 2-or-more points that
 * never actually move (every point identical — a GPS fix logged twice at a
 * dead stop, not a route). Both are the same case in disguise: neither has a
 * line to draw, only `M x y` with nowhere to go. That is deliberately not an
 * error path — a pool swim, a trainer ride and a treadmill run have no GPS at
 * all (ACTIVITIES.md's second bullet), and "this activity has no route" is a
 * normal, common answer that the card layer (§7: "must read as a deliberate
 * second design") is built to handle, not a malformed-input case this
 * function should throw on.
 */
export function routePath(points: [number, number][], opts: RoutePathOptions = {}): string | null {
	if (points.length < 2) return null;

	const maxPoints = opts.maxPoints ?? 200;
	const padding = opts.padding ?? 6;
	const size = opts.viewBoxSize ?? 100;

	const projected = points.map(([lat, lng]) => mercator(lat, lng));
	const simplified = simplifyToLimit(projected, maxPoints);
	if (simplified.length < 2) return null;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of simplified) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const spanX = maxX - minX;
	const spanY = maxY - minY;

	// No movement at all — every surviving point projects to the same spot.
	// This is the "2 identical points" case: not fewer than 2 points, but
	// there is still no *line*, only a stack of coincident ones, so it gets
	// the same null a too-short track gets rather than degrading into a
	// path string that's just `M x y` with an accidental repeat. A real GPS
	// track essentially never has exactly-zero span (device jitter alone
	// guarantees float noise), so this only ever fires on the genuinely
	// degenerate case, not on a real short-and-slow activity.
	if (spanX === 0 && spanY === 0) return null;

	const drawable = size - padding * 2;

	// A single-scale fit (not independent x/y scales) so a route's shape isn't
	// stretched to fill a square it was never square in — a straight-line
	// out-and-back stays a straight line, not a diagonal-to-square smear.
	const largestSpan = Math.max(spanX, spanY) || 1;
	const scale = drawable / largestSpan;

	// Mercator y increases northward but SVG y increases downward, so y is
	// flipped during the fit — otherwise every route would render upside down.
	const offsetX = (size - spanX * scale) / 2;
	const offsetY = (size - spanY * scale) / 2;

	const toSvg = ([x, y]: [number, number]): [number, number] => [
		offsetX + (x - minX) * scale,
		offsetY + (spanY - (y - minY)) * scale,
	];

	const svgPoints = simplified.map(toSvg);
	const [startX, startY] = svgPoints[0];
	let d = `M${startX.toFixed(1)} ${startY.toFixed(1)}`;
	for (let i = 1; i < svgPoints.length; i++) {
		const [x, y] = svgPoints[i];
		d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
	}
	return d;
}
