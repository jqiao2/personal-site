// Trace the outline of any shape as a rideable route — used as a stencil.
//
// The tool this feeds isn't for literally riding a country's border. You load a
// shape (a country silhouette, a pasted polygon), it floats fixed above the map
// at a constant screen size, and you pan/zoom the real map underneath to drop
// that shape over roads you'd actually ride — at whatever scale the map zoom
// gives it. On "generate", the shape's on-screen pixels are unprojected to
// wherever they now sit and handed, in order, to BRouter, whose one job is to
// connect an ordered waypoint list along real rideable roads. What comes back is
// a road route in the shape of the thing, dropped where you placed it.
//
// This file is the shape + routing maths: pulling an outline out of any GeoJSON,
// normalizing it to a screen box, orienting its winding (clockwise vs not),
// resampling, scoring how faithfully the roads traced it, GPX, and the two API
// calls. The screen-to-map placement and the overlay live on the page.
//
// Everything here is coordinate order [lng, lat] — GeoJSON's order, MapLibre's
// order, BRouter's order — never [lat, lng]. Distances are metres.

export type LngLat = [number, number];

// BRouter's public service. `lonlats` is the ordered waypoint list; it routes
// between consecutive pairs on rideable ways and returns one LineString.
const BROUTER = 'https://brouter.de/brouter';
// Nominatim gives us the outline of any named place as GeoJSON.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Natural Earth's land-clipped country polygons (110m — ~210KB, CORS-open). We
// prefer these for countries because Nominatim's admin boundary drags in
// territorial water, which bloats the coastline into blocky offshore steps that
// aren't a shape anyone would trace. NE follows the actual coast.
const NE_COUNTRIES =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';

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

/**
 * Flatten a lng/lat ring into a centered unit box for drawing as a fixed-size
 * screen stencil. The longer axis spans [-0.5, 0.5]; the page scales that by a
 * pixel size and drops it at the map's centre. Longitude is squeezed by
 * cos(latitude) so the silhouette keeps its true proportions instead of
 * stretching east-west, and latitude is negated because screen y grows downward
 * while north is up. The geographic meaning is re-derived at generate time by
 * unprojecting these screen points, so this is purely how the shape *looks*.
 */
export function normalizeShape(ring: LngLat[]): [number, number][] {
	const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
	const k = Math.cos((meanLat * Math.PI) / 180);
	const flat = ring.map(([lng, lat]) => [lng * k, -lat] as [number, number]);
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const [x, y] of flat) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
	const span = Math.max(maxX - minX, maxY - minY) || 1;
	return flat.map(([x, y]) => [(x - cx) / span, (y - cy) / span]);
}

/** Signed area of a ring (shoelace, x=lng y=lat): positive is counter-clockwise
 *  in a north-up frame. */
function signedArea(ring: LngLat[]): number {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return s / 2;
}

/** Return the ring wound in the requested direction, reversing it if it isn't
 *  already. `clockwise` here is as the rider sees it on a north-up map. */
export function orientRing(ring: LngLat[], clockwise: boolean): LngLat[] {
	const isClockwise = signedArea(ring) < 0;
	return isClockwise === clockwise ? ring.slice() : ring.slice().reverse();
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
	ring: LngLat[];
}

// The Natural Earth country set, fetched once and reused. Kept module-level so a
// second lookup doesn't re-download the file.
let neCache: Promise<any> | null = null;
function naturalEarth(): Promise<any> {
	if (!neCache) {
		neCache = fetch(NE_COUNTRIES).then((r) => {
			if (!r.ok) throw new Error(`Country data failed (${r.status}).`);
			return r.json();
		});
	}
	return neCache;
}

/** Find a country in the Natural Earth set by an exact (case-insensitive) name
 *  or ISO code, so "Italy", "italy", "IT" and "ITA" all land. */
function matchCountry(fc: any, query: string): any | null {
	const q = query.trim().toLowerCase();
	const fields = ['ADMIN', 'NAME', 'NAME_LONG', 'NAME_EN', 'BRK_NAME', 'ISO_A2', 'ISO_A3'];
	return (
		fc.features.find((f: any) => fields.some((k) => String(f.properties[k] ?? '').toLowerCase() === q)) ?? null
	);
}

/**
 * Look up a place and return its outline ring. Countries come from Natural
 * Earth's land-clipped silhouettes (no territorial-water bloat); everything
 * else — parks, lakes, cities, and the small countries NE drops at 110m —
 * falls back to Nominatim's `polygon_geojson`.
 */
export async function fetchOutline(query: string): Promise<Outline> {
	try {
		const fc = await naturalEarth();
		const hit = matchCountry(fc, query);
		if (hit) return { name: hit.properties.ADMIN, ring: outerRing(hit.geometry) };
	} catch {
		// A country-data hiccup shouldn't sink the lookup — try Nominatim.
	}
	const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&polygon_geojson=1&limit=1`;
	const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
	if (!res.ok) throw new Error(`Place lookup failed (${res.status}).`);
	const hits = await res.json();
	if (!Array.isArray(hits) || hits.length === 0) throw new Error(`No place found for "${query}".`);
	const hit = hits[0];
	if (!hit.geojson) throw new Error(`"${hit.display_name}" has no outline to trace.`);
	return { name: hit.display_name.split(',')[0], ring: outerRing(hit.geojson) };
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
