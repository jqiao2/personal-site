// The alpine basemap for the activity detail page — ACTIVITIES.md §1, §2.
//
// This is the one page in the section where the map IS the content, not a
// widget beside it (§1: "primarily a view of the activity on an interactive
// map"), so it gets its own basemap rather than reusing the restaurant log's
// cream-paper one (src/lib/map-style.ts) or inventing a third palette by eye.
// Same authored-not-vendor approach as that file — MapTiler supplies the
// vector tiles (OpenMapTiles schema), every colour below is ours, and the
// palette is exactly ACTIVITIES.md §2's ALPINE tokens (src/lib/
// activity-tokens.ts), not a lookalike.
//
// WHY THE GROUND READS AS GRANITE/SNOW, NOT AS THE RESTAURANT LOG'S CREAM.
// That page is paper a pin is printed on; this one is rock and snow above the
// treeline that a route is drawn across. `land` sits between ALPINE.snow and
// ALPINE.sky — cold and pale rather than warm — so the route's `lake` blue is
// the only saturated thing in the frame (§2's "one saturated thing per view"),
// and forest/water read as tinted variations on the same cold palette instead
// of introducing new hues.
//
// WHY WATER IS `lake`/`glacier` HERE BUT GREEN ON THE RESTAURANT MAP. That
// page reserves blue for nothing so a terracotta pin has no competition; this
// page's whole reason for existing is a blue route line, and real alpine
// lakes and rivers really are that cold blue-green — glacier for wide fills,
// lake's deeper tone for outlines — so water gets to be the honest colour
// here instead of the one hue everything else avoids.
//
// WHY THERE IS A HILLSHADE AND A CONTOUR LAYER. A ride or hike's whole point
// is usually the terrain, and a flat street basemap makes a 3,000ft climb
// look identical to a flat tempo ride. MapTiler's terrain-RGB tiles feed
// MapLibre's built-in `hillshade` layer type (elevation shading, no styling
// of our own to get wrong) and a `contours` vector tileset adds thin lines at
// legible zooms — both optional, additive layers that degrade to nothing
// (not to an error) if MapTiler ever changes or gates either product, because
// every tile source below fails silently the same way RestaurantMap's does.
//
// WHY ROADS AND BUILDINGS ARE BARELY THERE. Half of what shows up here is a
// mountain pass with no streets worth naming; the other half is a city ride
// where roads matter, but even then they are context for the route, not the
// subject of it. Both cases are served by drawing roads a shade off the
// ground rather than the restaurant map's readable street grid — enough to
// orient by by, never enough to compete with the route line.
import { ALPINE } from './activity-tokens';
import { decodePolyline, bounds as trackBounds, splitOnGaps, type Bounds } from './route-shape';

export const ACTIVITY_MAP_TOKENS = {
	// Ground: colder and paler than ALPINE.snow itself, so the *route's* white
	// space (start/finish rings, the empty-key fallback) still reads as paper
	// against it.
	land: '#eef3f6',
	water: ALPINE.glacier,
	waterLine: ALPINE.lake,
	park: '#dfe9e1', // a desaturated tint of ALPINE.fir — forest, not lawn-green
	forest: ALPINE.fir,
	building: '#e2e9ec',
	roadMinor: '#e2eaee',
	roadMajor: '#d7e2e8',
	roadCasing: '#c3d3db',
	boundary: '#b7c6ce',
	contour: '#b9c8d1',
	contourIndex: '#a3b7c2',
	hillshadeShadow: ALPINE.granite,
	hillshadeHighlight: ALPINE.snow,
	label: ALPINE.graniteSoft,
	labelHalo: ALPINE.snow,
	route: ALPINE.lake, // the one saturated thing on screen — §2
	routeCasing: ALPINE.snow,
	start: ALPINE.lake,
	finish: ALPINE.lake,
} as const;

const TILES = 'https://api.maptiler.com/tiles/v3/tiles.json';
const TERRAIN_RGB = 'https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json';
const CONTOURS = 'https://api.maptiler.com/tiles/contours/tiles.json';
const GLYPHS = 'https://api.maptiler.com/fonts/{fontstack}/{range}.pbf';

/**
 * The alpine style JSON, built around a public MapTiler key — same contract
 * as menuBasemap() in map-style.ts: the key is compiled into the page (that
 * is how MapLibre works; the domain allowlist in the MapTiler dashboard is
 * the real control, not secrecy).
 */
export function alpineBasemap(key: string) {
	const t = ACTIVITY_MAP_TOKENS;
	return {
		version: 8 as const,
		name: "Jason's activity log",
		glyphs: `${GLYPHS}?key=${key}`,
		sources: {
			base: { type: 'vector' as const, url: `${TILES}?key=${key}` },
			terrain: { type: 'raster-dem' as const, url: `${TERRAIN_RGB}?key=${key}`, encoding: 'terrarium' as const },
			contours: { type: 'vector' as const, url: `${CONTOURS}?key=${key}` },
		},
		layers: [
			{ id: 'ground', type: 'background' as const, paint: { 'background-color': t.land } },
			{
				// Terrain relief first, under everything else — a wash, not a
				// picture. Only worth the tile cost once you're close enough to a
				// slope for it to read as anything but noise.
				id: 'hillshade',
				type: 'hillshade' as const,
				source: 'terrain',
				minzoom: 9,
				paint: {
					'hillshade-shadow-color': t.hillshadeShadow,
					'hillshade-highlight-color': t.hillshadeHighlight,
					'hillshade-accent-color': t.hillshadeShadow,
					'hillshade-exaggeration': 0.35,
				},
			},
			{
				id: 'park',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'park',
				paint: { 'fill-color': t.park, 'fill-opacity': 0.8 },
			},
			{
				// Forest reads as fir over the hillshade, not as flat lawn — this is
				// the one land-cover fill besides park worth naming at this zoom
				// range; everything else stays the bare granite ground.
				id: 'wood',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'landcover',
				filter: ['==', 'class', 'wood'],
				paint: { 'fill-color': t.forest, 'fill-opacity': 0.22 },
			},
			{
				id: 'water',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'water',
				paint: { 'fill-color': t.water },
			},
			{
				id: 'waterway',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'waterway',
				paint: { 'line-color': t.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 15, 2] },
			},
			{
				// Elevation contours — thin everywhere, a shade darker on the index
				// lines a hiker would actually read a number off. Both draw the same
				// way if the tileset doesn't carry an `index` flag; nothing errors,
				// it's just all one weight.
				id: 'contour-line',
				type: 'line' as const,
				source: 'contours',
				'source-layer': 'contour',
				minzoom: 11,
				filter: ['!=', ['get', 'index'], 1],
				paint: { 'line-color': t.contour, 'line-width': 0.6, 'line-opacity': 0.7 },
			},
			{
				id: 'contour-line-index',
				type: 'line' as const,
				source: 'contours',
				'source-layer': 'contour',
				minzoom: 10,
				filter: ['==', ['get', 'index'], 1],
				paint: { 'line-color': t.contourIndex, 'line-width': 1 },
			},
			{
				id: 'building',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'building',
				minzoom: 14,
				paint: {
					'fill-color': t.building,
					'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 16, 0.9],
				},
			},
			{
				id: 'road-casing',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'transportation',
				filter: ['in', 'class', 'motorway', 'trunk', 'primary'],
				layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
				paint: {
					'line-color': t.roadCasing,
					'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 1.2, 16, 7],
				},
			},
			{
				id: 'road-minor',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'transportation',
				filter: ['in', 'class', 'minor', 'service', 'street', 'residential', 'path', 'track'],
				minzoom: 11,
				paint: {
					'line-color': t.roadMinor,
					'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 0.4, 18, 5],
				},
			},
			{
				id: 'road-major',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'transportation',
				filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
				layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
				paint: {
					'line-color': t.roadMajor,
					'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 0.6, 16, 5.5],
				},
			},
			{
				id: 'boundary',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'boundary',
				filter: ['<=', 'admin_level', 6],
				paint: { 'line-color': t.boundary, 'line-width': 0.7, 'line-dasharray': [3, 2], 'line-opacity': 0.6 },
			},
			{
				id: 'label-place',
				type: 'symbol' as const,
				source: 'base',
				'source-layer': 'place',
				filter: ['in', 'class', 'city', 'town', 'village', 'suburb', 'neighbourhood'],
				layout: {
					'text-field': ['get', 'name'],
					'text-font': ['Noto Sans Medium'],
					'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 12.5],
					'text-letter-spacing': 0.1,
					'text-max-width': 8,
				},
				paint: { 'text-color': t.label, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.4 },
			},
		],
	};
}

/** The bare-ground fallback when there is no MapTiler key — matches
 *  RestaurantMap's degrade path (map-style.ts has no export for this because
 *  its own fallback is written inline; kept as a real export here since the
 *  no-GPS/no-key states can combine and both callers on this page reach for
 *  it). */
export function bareAlpineGround() {
	return {
		version: 8 as const,
		sources: {},
		layers: [
			{ id: 'ground', type: 'background' as const, paint: { 'background-color': ACTIVITY_MAP_TOKENS.land } },
		],
	};
}

// ---------------------------------------------------------------------------
// Route geometry
// ---------------------------------------------------------------------------

export interface RouteGeoJSON {
	type: 'Feature';
	geometry: { type: 'MultiLineString'; coordinates: [number, number][][] };
	properties: Record<string, never>;
}

/** Decodes the full-fidelity `polyline` column (not the thumbnail's simplified
 *  `route_path` — §1) to a GeoJSON MultiLineString in [lng, lat] order, the way
 *  every GeoJSON/MapLibre source expects coordinates, the reverse of the
 *  `[lat, lng]` pairs route-shape.ts's decoder returns.
 *
 *  MULTI, NOT SINGLE, so the drawn line *breaks* at a recording gap instead of
 *  running a straight diagonal across ground never covered — a ride paused at
 *  125th St and restarted in the Bronx is two lines, not one that cuts through
 *  Harlem. The break itself is the honest picture; `routeGapsGeoJSON` adds the
 *  faint dashed hop that says "recording paused here" across it. A continuous
 *  track is a MultiLineString of one member — the layers below don't care. */
export function polylineToGeoJSON(polyline: string): RouteGeoJSON {
	const pieces = splitOnGaps(decodePolyline(polyline));
	return {
		type: 'Feature',
		geometry: {
			type: 'MultiLineString',
			coordinates: pieces.map((piece) => piece.map(([lat, lng]) => [lng, lat])),
		},
		properties: {},
	};
}

/** The straight hops the recording skipped over — one [lng, lat] segment per
 *  gap, from where the track stopped to where it resumed. Drawn faint and
 *  dashed so a pause reads as "jumped here", not as ground actually covered.
 *  Empty (no members) for a continuous track. */
export function routeGapsGeoJSON(polyline: string): RouteGeoJSON {
	const pieces = splitOnGaps(decodePolyline(polyline));
	const hops: [number, number][][] = [];
	for (let i = 1; i < pieces.length; i++) {
		const prev = pieces[i - 1];
		const [aLat, aLng] = prev[prev.length - 1];
		const [bLat, bLng] = pieces[i][0];
		hops.push([
			[aLng, aLat],
			[bLng, bLat],
		]);
	}
	return { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: hops }, properties: {} };
}

export interface StartFinish {
	start: [number, number]; // [lng, lat]
	finish: [number, number];
}

/** The first and last recorded points, in [lng, lat] order — null if the
 *  polyline decodes to fewer than 2 points (nothing to mark). */
export function startFinish(polyline: string): StartFinish | null {
	const points = decodePolyline(polyline);
	if (points.length < 2) return null;
	const [sLat, sLng] = points[0];
	const [fLat, fLng] = points[points.length - 1];
	return { start: [sLng, sLat], finish: [fLng, fLat] };
}

/** Bounding box of the decoded track, in the `[[w,s],[e,n]]` form
 *  `maplibregl.LngLatBoundsLike` accepts — computed from the full polyline
 *  rather than trusting the stored `bbox_*` columns, which can be null even
 *  when `polyline` is present (an earlier ingest that predates the bbox
 *  columns, say). Null if the track never actually moves. */
export function routeBoundsLngLat(polyline: string): [[number, number], [number, number]] | null {
	const b: Bounds | null = trackBounds(decodePolyline(polyline));
	if (!b) return null;
	return [
		[b.w, b.s],
		[b.e, b.n],
	];
}
