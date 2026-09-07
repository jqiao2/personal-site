// Trace the outline of any shape as a rideable route.
//
// The manual workflow this replaces: drop a 50%-opaque country on top of
// RideWithGPS and hand-plot the border onto roads. The insight that collapses
// most of that work is that a cycling router already does the hard part — given
// an ordered list of waypoints it will connect them along real, rideable roads.
// So the whole pipeline is: take any GeoJSON shape (a country from Nominatim, a
// pasted polygon, a lake, a park), pull its outline, drop a waypoint every few
// km around it, and hand that ordered list to BRouter. What comes back is a
// continuous road route in the shape of the thing. The border deviation stats
// tell you how faithfully the roads managed to trace it.
//
// Everything here is coordinate order [lng, lat] — GeoJSON's order, MapLibre's
// order, BRouter's order — never [lat, lng]. Distances are metres.

export type LngLat = [number, number];

// BRouter's public service. `lonlats` is the ordered waypoint list; it routes
// between consecutive pairs on rideable ways and returns one LineString.
const BROUTER = 'https://brouter.de/brouter';
// Nominatim gives us the outline of any named place as GeoJSON.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// URL length and the router's own limits cap how many waypoints one request can
// carry. ponytail: hard cap, not a chunker — past this the caller is told to
// widen the spacing. A country at 120 waypoints is already a recognizable shape.
export const MAX_WAYPOINTS = 120;

// Profiles the public brouter.de server ships. `trekking` is the sensible
// bike default; `safety` favours quiet roads; `shortest` hugs the border
// hardest (fewest detours), which is often what an outline ride wants.
export const PROFILES = ['trekking', 'fastbike', 'safety', 'shortest'] as const;
export type Profile = (typeof PROFILES)[number];

// --- geometry -------------------------------------------------------------

/** Metres between two [lng, lat] points (haversine). */
export function haversine(a: LngLat, b: LngLat): number {
	const R = 6371000;
	const toRad = Math.PI / 180;
	const dLat = (b[1] - a[1]) * toRad;
	const dLng = (b[0] - a[0]) * toRad;
	const la1 = a[1] * toRad;
	const la2 = b[1] * toRad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Planar shoelace area of a ring, in degree² — only ever used to rank rings
 *  against each other, so the units don't matter, only the ordering. */
function ringArea(ring: LngLat[]): number {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return Math.abs(s) / 2;
}

/** Total length of an open path, in degree² — used to rank linestrings. */
function pathSpan(line: LngLat[]): number {
	let s = 0;
	for (let i = 1; i < line.length; i++) {
		s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
	}
	return s;
}

/**
 * The single outline to trace, pulled out of any GeoJSON object. Handles a
 * FeatureCollection, a Feature, or a bare geometry, and for shapes made of
 * several pieces picks the biggest one — the mainland, not an offshore island —
 * so "Portugal" traces Portugal and not the Azores.
 */
export function outerRing(input: unknown): LngLat[] {
	const geom = toGeometry(input);
	if (!geom) throw new Error('No polygon or line found in that GeoJSON.');
	switch (geom.type) {
		case 'Polygon':
			return geom.coordinates[0] as LngLat[];
		case 'MultiPolygon': {
			const rings: LngLat[][] = geom.coordinates.map((poly: LngLat[][]) => poly[0] as LngLat[]);
			return rings.reduce((best: LngLat[], r: LngLat[]) => (ringArea(r) > ringArea(best) ? r : best));
		}
		case 'LineString':
			return geom.coordinates as LngLat[];
		case 'MultiLineString': {
			const lines = geom.coordinates as LngLat[][];
			return lines.reduce((best, l) => (pathSpan(l) > pathSpan(best) ? l : best));
		}
		default:
			throw new Error(`Can't trace a ${geom.type}.`);
	}
}

function toGeometry(input: any): any {
	if (!input || typeof input !== 'object') return null;
	if (input.type === 'FeatureCollection') {
		// The feature with the largest outline wins, same reasoning as picking the
		// mainland ring above.
		let best: any = null;
		let bestSize = -1;
		for (const f of input.features ?? []) {
			const g = toGeometry(f);
			if (!g) continue;
			const size = geomSize(g);
			if (size > bestSize) {
				bestSize = size;
				best = g;
			}
		}
		return best;
	}
	if (input.type === 'Feature') return input.geometry ?? null;
	if (input.type && input.coordinates) return input;
	return null;
}

function geomSize(geom: any): number {
	try {
		const ring = outerRing(geom);
		return ring.length > 2 && geom.type.includes('Polygon') ? ringArea(ring) : pathSpan(ring);
	} catch {
		return -1;
	}
}

/**
 * Walk the outline and drop a point every `spacing` metres. This both samples
 * and simplifies: the wiggles finer than the spacing vanish, which is what you
 * want — the ride should read as the country's shape, not chase every metre of
 * a border no road follows anyway. The first point is always kept, and the last
 * is snapped back to the first so the ride closes into a loop.
 */
export function resample(ring: LngLat[], spacing: number): LngLat[] {
	if (ring.length < 2) return ring.slice();
	const out: LngLat[] = [ring[0]];
	let carried = 0; // distance walked since the last emitted point
	for (let i = 1; i < ring.length; i++) {
		const a = ring[i - 1];
		const b = ring[i];
		let segLen = haversine(a, b);
		if (segLen === 0) continue;
		let start = 0; // fraction of [a,b] already consumed
		while (carried + (1 - start) * segLen >= spacing) {
			const need = spacing - carried;
			const t = start + need / segLen;
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			start = t;
			carried = 0;
		}
		carried += (1 - start) * segLen;
	}
	// Close the loop back to the start rather than leaving a dangling last vertex.
	if (haversine(out[out.length - 1], ring[0]) > spacing / 4) out.push(ring[0]);
	return out;
}

/** Length of a path in metres. */
export function pathLength(coords: LngLat[]): number {
	let s = 0;
	for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
	return s;
}

/** Metres from point `p` to segment `a`–`b`, in a local flat projection good
 *  enough at ride scale (a few hundred km). */
function pointToSegment(p: LngLat, a: LngLat, b: LngLat): number {
	const latRad = (p[1] * Math.PI) / 180;
	const mx = 111320 * Math.cos(latRad); // metres per degree lng at this latitude
	const my = 110540; // metres per degree lat
	const px = p[0] * mx, py = p[1] * my;
	const ax = a[0] * mx, ay = a[1] * my;
	const bx = b[0] * mx, by = b[1] * my;
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export interface Deviation {
	mean: number;
	p95: number;
	max: number;
}

/**
 * How far the road route strays from the outline it was meant to trace —
 * "border fidelity". For every point on the route, the distance to the nearest
 * segment of the target outline; reported as mean / 95th percentile / max.
 */
export function deviation(route: LngLat[], target: LngLat[]): Deviation {
	if (route.length === 0 || target.length < 2) return { mean: 0, p95: 0, max: 0 };
	const dists: number[] = [];
	for (const p of route) {
		let min = Infinity;
		for (let i = 1; i < target.length; i++) {
			const d = pointToSegment(p, target[i - 1], target[i]);
			if (d < min) min = d;
		}
		dists.push(min);
	}
	dists.sort((x, y) => x - y);
	const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
	const p95 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.95))];
	return { mean, p95, max: dists[dists.length - 1] };
}

/** A GPX track from a list of [lng, lat] points, ready to import into
 *  RideWithGPS. */
export function toGPX(coords: LngLat[], name: string): string {
	const pts = coords
		.map(([lng, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`)
		.join('\n');
	const safe = name.replace(/[<&>]/g, '');
	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="jqiao.vercel.app" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${safe}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>`;
}

// --- network --------------------------------------------------------------

export interface Outline {
	name: string;
	geometry: unknown;
}

/** Look up any named place (a country, a city, a park, a lake) and return its
 *  outline geometry. Nominatim is the gazetteer; `polygon_geojson=1` asks it
 *  for the boundary rather than just a pin. */
export async function fetchOutline(query: string): Promise<Outline> {
	const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&polygon_geojson=1&limit=1`;
	const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
	if (!res.ok) throw new Error(`Place lookup failed (${res.status}).`);
	const hits = await res.json();
	if (!Array.isArray(hits) || hits.length === 0) throw new Error(`No place found for "${query}".`);
	const hit = hits[0];
	if (!hit.geojson) throw new Error(`"${hit.display_name}" has no outline to trace.`);
	return { name: hit.display_name, geometry: hit.geojson };
}

export interface RoutedPath {
	coords: LngLat[];
	/** Route length in metres, as the router reports it. */
	length: number;
	/** Total climb in metres, if the router reports it. */
	ascend: number | null;
}

/** Route through an ordered waypoint list on rideable roads via BRouter. */
export async function routeWaypoints(waypoints: LngLat[], profile: Profile): Promise<RoutedPath> {
	if (waypoints.length < 2) throw new Error('Need at least two waypoints to route.');
	if (waypoints.length > MAX_WAYPOINTS) {
		throw new Error(`${waypoints.length} waypoints exceeds the ${MAX_WAYPOINTS} limit — widen the spacing.`);
	}
	const lonlats = waypoints.map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join('|');
	const url = `${BROUTER}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Router failed (${res.status}). The shape may cross water with no road bridge.`);
	const fc = await res.json();
	const feat = fc?.features?.[0];
	if (!feat?.geometry?.coordinates?.length) throw new Error('Router returned no route.');
	// BRouter's LineString may be [lng, lat, ele] triples; keep just [lng, lat].
	const coords: LngLat[] = feat.geometry.coordinates.map((c: number[]) => [c[0], c[1]]);
	const props = feat.properties ?? {};
	return {
		coords,
		length: Number(props['track-length']) || pathLength(coords),
		ascend: props['filtered ascend'] != null ? Number(props['filtered ascend']) : null,
	};
}
