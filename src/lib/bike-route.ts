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
// Natural Earth's land-clipped country polygons (50m — ~1MB gzipped, CORS-open,
// fetched once per session). We prefer these for countries because Nominatim's
// admin boundary drags in territorial water, which bloats the coastline into
// blocky offshore steps that aren't a shape anyone would trace. NE follows the
// actual coast. 50m, not 110m: 110m is too coarse for smaller countries (Taiwan
// was ~9 points, a crude blob that bulged past its own coast); 50m gives ~60,
// enough for a recognizable silhouette without the 25MB of the 10m set.
const NE_COUNTRIES =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// One BRouter request stays comfortable at ~100 waypoints (URL length, server
// cost). Beyond that we chunk into overlapping batches and stitch, so a shape
// can be traced with many more points than a single request would take — denser
// sampling is what keeps the road route hugging the outline instead of taking
// long detours between far-apart waypoints (a big source of retraced road).
const BATCH = 100;
// The overall ceiling across all chunks — enough for a very detailed trace,
// while still bounding how many sequential requests we fire at the public server.
export const MAX_WAYPOINTS = 600;

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
export function resample(ring: LngLat[], spacing: number, close = true): LngLat[] {
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
	// A country ring closes back to the start; an open trail (a line drawing, which
	// already walks its own path end to end) keeps its final vertex as its end.
	if (close && haversine(out[out.length - 1], ring[0]) > spacing / 4) out.push(ring[0]);
	else if (!close && out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
	return out;
}

/** Length of a path in metres. */
export function pathLength(coords: LngLat[]): number {
	let s = 0;
	for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
	return s;
}

/**
 * Remove out-and-back retracing from a routed path — the "double-backing" a
 * per-hop router produces when it dives down a road to reach a waypoint in a
 * notch and comes straight back over the same tarmac.
 *
 * A stack does it: walk the points, and whenever the next point steps back onto
 * the one before the top of the stack, that top was a spur tip — pop it instead
 * of pushing. This cancels a spur of any length (a → x → y → x → a collapses to
 * a) and nests, and because a spur always returns to where it began, cutting it
 * never breaks the path: the route just skips the dead-end excursion. Iterated
 * to a fixed point, since removing one spur can make its neighbours adjacent.
 * Genuine loops (which enclose area rather than retrace) are left alone.
 */
export function removeBacktracks(coords: LngLat[]): LngLat[] {
	const key = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
	let cur = coords;
	for (let pass = 0; pass < 8; pass++) {
		const st: LngLat[] = [];
		for (const p of cur) {
			if (st.length >= 2 && key(st[st.length - 2]) === key(p)) st.pop();
			else if (st.length === 0 || key(st[st.length - 1]) !== key(p)) st.push(p);
		}
		if (st.length === cur.length) return st; // stable
		cur = st;
	}
	return cur;
}

/**
 * Drop the "lasso" loops a per-hop router makes to reach a waypoint — it leaves
 * the outline, circles a block, touches the waypoint, and rejoins near where it
 * left, enclosing area rather than retracing (so removeBacktracks can't see it).
 *
 * Detected as a near-return: a later point that lands back within `tol` of an
 * earlier one after a much longer path than the straight chord between them
 * (`path > minLoop` and `path > 4·chord`, so a genuine tight bend isn't cut).
 * The excursion is spliced out by jumping straight to the return point, which
 * bounds the one introduced connector to the chord (≤ tol), and every point
 * after it stays original road geometry. Iterated, since cutting one loop can
 * bring the next into range.
 *
 * A thin *intended* feature — a peninsula the outline itself asked for, like
 * Florida — looks exactly like a lasso (down one road, up a parallel one within
 * `tol`). What tells them apart is the waypoints: a real peninsula carries a run
 * of the outline's own sample points down and back, a router lasso between two
 * waypoints carries none in between. So when `anchorKeys` (the keys of route
 * points nearest each waypoint) is given, an excursion holding two or more of
 * them is kept, not cut.
 */
export function removeLoops(
	coords: LngLat[],
	tol = 70,
	minLoop = 250,
	maxLoop = 6000,
	anchorKeys?: Set<string>,
): LngLat[] {
	const key = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
	let cur = coords;
	for (let pass = 0; pass < 6; pass++) {
		const out: LngLat[] = [];
		let i = 0;
		while (i < cur.length) {
			out.push(cur[i]);
			let best = -1;
			let path = 0;
			let anchorsInside = 0;
			for (let j = i + 1; j < cur.length && path <= maxLoop; j++) {
				path += haversine(cur[j - 1], cur[j]);
				if (anchorKeys?.has(key(cur[j - 1])) && j - 1 > i) anchorsInside++;
				const chord = haversine(cur[i], cur[j]);
				// Two-plus of the outline's own waypoints inside ⇒ intended feature, leave it.
				if (path > minLoop && chord <= tol && path > 4 * chord && anchorsInside < 2) best = j;
			}
			i = best >= 0 ? best : i + 1;
		}
		if (out.length === cur.length) return out;
		cur = out;
	}
	return cur;
}

/** Keys (5-dp) of the route point nearest each waypoint — the route's "anchors",
 *  the points the outline actually asked for, so cleanup can spare intended thin
 *  features (peninsulas) while still cutting router artifacts. */
function anchorKeySet(coords: LngLat[], waypoints: LngLat[]): Set<string> {
	const set = new Set<string>();
	for (const w of waypoints) {
		let bi = -1, bd = Infinity;
		for (let i = 0; i < coords.length; i++) {
			const d = (coords[i][0] - w[0]) ** 2 + (coords[i][1] - w[1]) ** 2;
			if (d < bd) { bd = d; bi = i; }
		}
		if (bi >= 0) set.add(`${coords[bi][0].toFixed(5)},${coords[bi][1].toFixed(5)}`);
	}
	return set;
}

/** Fraction of the route (0–1) that rides a road segment already ridden — the
 *  "wrong-way / sidewalk" proxy, since the road graph's legal directions aren't
 *  available here. Undirected: a segment counts as reused however it's traversed. */
export function retracedFraction(coords: LngLat[]): number {
	const key = (a: LngLat, b: LngLat) => {
		const ka = `${a[0].toFixed(5)},${a[1].toFixed(5)}`;
		const kb = `${b[0].toFixed(5)},${b[1].toFixed(5)}`;
		return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
	};
	const seen = new Set<string>();
	let total = 0, reused = 0;
	for (let i = 1; i < coords.length; i++) {
		const L = haversine(coords[i - 1], coords[i]);
		if (L === 0) continue;
		total += L;
		const k = key(coords[i - 1], coords[i]);
		if (seen.has(k)) reused += L;
		else seen.add(k);
	}
	return total ? reused / total : 0;
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

// --- placement search ------------------------------------------------------
//
// You draw an outline and a rough area, but you don't know exactly where in that
// area the shape sits best on real roads. This searches the placement by direct
// hill-climbing on road fidelity: route the shape where it sits, then try nudging
// the whole shape N/S/E/W (and, within a bound, scaling it up or down), keep any
// move that makes the road route trace the outline more faithfully, and repeat.
// The step starts bold — a quarter of the shape's own size — so early moves reach
// clear across the area instead of inching; when no neighbour improves, the step
// halves to refine in place, and the sample spacing tightens each level. It ends
// at the spacing floor or a hard cap on router calls, returning the best it saw.
//
// This replaced a timid single-direction slide (0.2 of the mean offset per round)
// that barely moved — fine for a country you eyeball into place, useless for a
// line drawing dropped anywhere. Scaling is bounded (default ±15%) on purpose, so
// the fitted ride stays about as long as you intended; set maxScale to 0 to pin
// the size and search translation only.
// ponytail: greedy local search — a bold coordinate-descent, not simulated
// annealing. It can still settle in a local optimum; if that bites, seed a few
// random restarts or anneal. Router calls are the cost, so maxEvals caps them.

/** Centroid of a ring (mean of its vertices). */
function centroidOf(ring: LngLat[]): LngLat {
	let sx = 0, sy = 0;
	for (const p of ring) { sx += p[0]; sy += p[1]; }
	return [sx / ring.length, sy / ring.length];
}

/** Scale a ring about `c` by `sMul`, then translate by (dx, dy). */
function transform(ring: LngLat[], dx: number, dy: number, sMul: number, c: LngLat): LngLat[] {
	return ring.map(([x, y]) => [c[0] + (x - c[0]) * sMul + dx, c[1] + (y - c[1]) * sMul + dy] as LngLat);
}

/** The bounding-box diagonal of a ring, in degrees — the shape's own size, used
 *  to scale the search step so "a quarter of the shape" means the same whether the
 *  outline spans a city or a country. */
function ringSpan(ring: LngLat[]): number {
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const [x, y] of ring) {
		if (x < minX) minX = x; if (x > maxX) maxX = x;
		if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	return Math.hypot(maxX - minX, maxY - minY) || 1;
}

export interface DescentRound {
	round: number;
	spacingKm: number;
	waypoints: number;
	meanDev: number;
	maxDev: number;
	scale: number; // cumulative scale vs the start (1 = unchanged)
	ring: LngLat[]; // the outline where it sat when this was reported
	routed: RoutedPath; // its route — draw it to watch the search
}

export interface DescentResult {
	ring: LngLat[]; // the placed outline that produced the best route
	waypoints: LngLat[];
	routed: RoutedPath;
	spacing: number; // metres, the spacing of the winning round
	rounds: number;
	scale: number; // final cumulative scale vs the start
}

export interface DescentOpts {
	startSpacing: number; // metres
	minSpacing: number; // metres — the floor
	shrink?: number; // spacing multiplier per level, 0<shrink<1 (default 0.85)
	maxScale?: number; // max |scale − 1| allowed, e.g. 0.15; 0 pins the size (default 0.15)
	maxEvals?: number; // hard cap on router calls the whole search may make (default 60)
	close?: boolean; // closed ring (country) or open trail (line drawing) — default true
	onRound?: (r: DescentRound) => void;
}

/**
 * Search where (and, within `maxScale`, how big) the shape sits so roads trace it
 * best. `route` is injected so this stays pure of network wiring (the page passes
 * a BRouter call). Returns the lowest-mean-deviation placement it found.
 */
export async function descend(
	ring0: LngLat[],
	route: (waypoints: LngLat[]) => Promise<RoutedPath>,
	opts: DescentOpts,
): Promise<DescentResult> {
	const shrink = opts.shrink ?? 0.85;
	const maxScale = opts.maxScale ?? 0.15;
	const maxEvals = opts.maxEvals ?? 60;
	const close = opts.close ?? true;
	const size = ringSpan(ring0);

	let ring = ring0.slice();
	let scale = 1; // cumulative scale vs ring0
	let spacing = opts.startSpacing;
	let evals = 0;
	// A holder, not a bare `let`: `best` is only ever assigned inside the `report`
	// closure, and TS won't narrow a closure-assigned local, so a property does it.
	const found: { best: DescentResult | null } = { best: null };
	let bestMean = Infinity;
	let round = 0;

	// Route the shape at the current spacing and score it. Null means "not a usable
	// placement" — too many waypoints, budget spent, or the router refused it (a
	// 400: the shape sits over water or a road-less patch). A refusal is not fatal:
	// the search simply doesn't move there and keeps trying other directions, which
	// is how it backs out of a step that wandered off the road network.
	const evalRing = async (r: LngLat[]) => {
		if (evals >= maxEvals) return null;
		const wp = resample(r, spacing, close);
		if (wp.length < 2 || wp.length > MAX_WAYPOINTS) return null;
		evals++;
		let routed: RoutedPath;
		try {
			routed = await route(wp);
		} catch {
			return null; // infeasible placement — skip it, don't crash the search
		}
		const dev = deviation(routed.coords, wp);
		return { wp, routed, mean: dev.mean, max: dev.max };
	};
	const report = (r: LngLat[], e: { wp: LngLat[]; routed: RoutedPath; mean: number; max: number }) => {
		opts.onRound?.({
			round, spacingKm: spacing / 1000, waypoints: e.wp.length,
			meanDev: e.mean, maxDev: e.max, scale, ring: r.slice(), routed: e.routed,
		});
		if (e.mean < bestMean) {
			bestMean = e.mean;
			found.best = { ring: r.slice(), waypoints: e.wp, routed: e.routed, spacing, rounds: round + 1, scale };
		}
	};

	while (spacing >= opts.minSpacing && evals < maxEvals) {
		const cur = await evalRing(ring);
		if (!cur) break;
		report(ring, cur);
		let curMean = cur.mean;
		let step = size * 0.25; // bold: reach across the area, not inch
		const minStep = size * 0.01;
		while (step >= minStep && evals < maxEvals) {
			// Neighbours: slide N/S/E/W by the current step, and (within the bound)
			// scale up/down. The first that improves fidelity is adopted; the search
			// keeps hopping in whichever directions keep paying off.
			const moves: [number, number, number][] = [
				[step, 0, 1], [-step, 0, 1], [0, step, 1], [0, -step, 1],
			];
			if (maxScale > 0) {
				const up = Math.min(1 + maxScale, scale * 1.05) / scale;
				const dn = Math.max(1 - maxScale, scale * 0.95) / scale;
				if (up > 1.0001) moves.push([0, 0, up]);
				if (dn < 0.9999) moves.push([0, 0, dn]);
			}
			let improved = false;
			for (const [dx, dy, sMul] of moves) {
				if (evals >= maxEvals) break;
				const trial = transform(ring, dx, dy, sMul, centroidOf(ring));
				const e = await evalRing(trial);
				if (e && e.mean < curMean - 1e-9) {
					ring = trial;
					curMean = e.mean;
					scale *= sMul;
					improved = true;
					round++;
					report(ring, e);
				}
			}
			if (!improved) step *= 0.5; // nothing nearer helped — look closer
		}
		spacing *= shrink;
	}
	if (!found.best) throw new Error('Could not route the outline at any spacing.');
	found.best.rounds = round;
	return found.best;
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
	/** Route length in metres. */
	length: number;
	/** Total climb in metres, if the router reports it. */
	ascend: number | null;
	/** Fraction (0–1) of the route on already-ridden road — the wrong-way proxy. */
	retraced: number;
}

/** One BRouter call over an ordered waypoint list. Returns the road geometry
 *  (as [lng, lat], dropping any elevation) and the climb it reports. */
async function brouterLeg(waypoints: LngLat[], profile: Profile): Promise<{ coords: LngLat[]; ascend: number }> {
	const lonlats = waypoints.map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join('|');
	const url = `${BROUTER}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Router failed (${res.status}). The shape may sit over water or a road-less area.`);
	const fc = await res.json();
	const feat = fc?.features?.[0];
	if (!feat?.geometry?.coordinates?.length) throw new Error('Router returned no route.');
	const coords: LngLat[] = feat.geometry.coordinates.map((c: number[]) => [c[0], c[1]]);
	const ascend = feat.properties?.['filtered ascend'];
	return { coords, ascend: ascend != null ? Number(ascend) : 0 };
}

/**
 * Route through an ordered waypoint list on rideable roads via BRouter, then
 * strip the out-and-back retracing the router leaves behind (removeBacktracks).
 *
 * Long lists are split into overlapping batches — each batch shares its last
 * waypoint with the next batch's first, so the legs join seam-to-seam — because
 * one request can't carry hundreds of waypoints. The cleanup runs on the
 * stitched whole: first removeBacktracks (out-and-back spurs), then removeLoops
 * (the block-circling lassoes), so an excursion straddling a seam is still cut.
 */
export async function routeWaypoints(waypoints: LngLat[], profile: Profile, cleanup = true): Promise<RoutedPath> {
	if (waypoints.length < 2) throw new Error('Need at least two waypoints to route.');
	if (waypoints.length > MAX_WAYPOINTS) {
		throw new Error(`${waypoints.length} waypoints exceeds the ${MAX_WAYPOINTS} limit — widen the spacing.`);
	}
	let coords: LngLat[] = [];
	let ascend = 0;
	for (let start = 0; start < waypoints.length - 1; start += BATCH - 1) {
		const batch = waypoints.slice(start, start + BATCH);
		const leg = await brouterLeg(batch, profile);
		ascend += leg.ascend;
		// Drop the first point of every leg after the first — it repeats the shared
		// seam waypoint the previous leg already ended on.
		coords = coords.length ? coords.concat(leg.coords.slice(1)) : leg.coords;
	}
	// A country outline is a simple loop, so any out-and-back or lasso is a router
	// artifact to strip. A line drawing's route *plans* its backtracking (the
	// Chinese-postman doubling), so cleanup would delete required coverage — the
	// caller turns it off for that mode.
	if (cleanup) {
		coords = removeBacktracks(coords);
		// Spare the outline's own thin features (peninsulas) from the lasso cleanup —
		// they carry a run of waypoints; a router artifact between waypoints doesn't.
		coords = removeLoops(coords, 70, 250, 6000, anchorKeySet(coords, waypoints));
		coords = removeBacktracks(coords); // a spliced loop can leave a small new spur
	}
	return { coords, length: pathLength(coords), ascend, retraced: retracedFraction(coords) };
}
