// /subway's "Map" view: the diagram's own stations and per-service segments
// (same ids, so the same saved log) drawn over a real map of the city.
//
// Geometry comes from subway-geo.js (scripts/generate-subway-geo.mjs): every
// segment is its service's real GTFS track between the two stations, cut into
// pieces whose `o` is its slot among the services sharing that stretch — so a
// line shifts gradually where its bundle changes instead of stepping.
//
// Parallel services fan apart with `line-offset`, which is in screen pixels, so
// the bundle keeps a constant on-screen width at any zoom — the same trick the
// SVG diagram does by hand. The generator reads each slot against its piece's own
// direction, so the offset's sign means the same side for every member.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// See RestaurantMap.astro: the tile worker has to go through Vite's worker build.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { menuBasemap, SUBWAY_MAP_TOKENS } from '../lib/map-style';
import { SEGMENTS, STATIONS } from './subway-data.js';
import { LINES, LINKS, STOPS } from './subway-geo.js';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

type Marks = { st: Record<string, 1>; seg: Record<string, 1> };

const on: maplibregl.ExpressionSpecification = ['boolean', ['feature-state', 'on'], false];

// Unridden track is the service colour faded into the (dark) ground, as the
// diagram fades it into its pale one. An opaque colour rather than line-opacity:
// a segment is several pieces, and translucent pieces darken where their round
// ends overlap — a dotted line.
function fade(hex: string) {
	const ground = [0x1a, 0x1c, 0x1e];

	return '#' + ground.map((g, j) => Math.round(parseInt(hex.slice(1 + j * 2, 3 + j * 2), 16) * 0.55 + g * 0.45).toString(16).padStart(2, '0')).join('');
}

// on the dark ground a visited marker is the light one
const INK = '#ecebe6', EDGE = '#80878b';

function lineGeoJSON() {
	return {
		type: 'FeatureCollection' as const,
		// a few phantom schematic links have no track and are left off (see the generator)
		// One feature per piece; a segment's pieces share its id, so feature-state
		// (ridden) and clicks treat them as one line.
		features: SEGMENTS.flatMap((sg) =>
			(LINES[sg.id] ?? []).map((piece) => ({
				type: 'Feature' as const,
				properties: { id: sg.id, o: piece.o, color: sg.color, faded: fade(sg.color) },
				geometry: { type: 'LineString' as const, coordinates: piece.c },
			})),
		),
	};
}

// One marker per platform a station's services use, all sharing the station id,
// so marking a complex visited fills every one of its platforms. Only the
// busiest platform carries the name, so a complex is labelled once.
const names = Object.fromEntries(STATIONS.map((s) => [s.id, s.name]));

function stationGeoJSON() {
	const labelled = new Set<number>();

	return {
		type: 'FeatureCollection' as const,
		features: [...STOPS].sort((a, b) => b.n - a.n).map((p) => {
			const first = !labelled.has(p.id);
			labelled.add(p.id);

			return {
				type: 'Feature' as const,
				properties: { id: p.id, name: first ? names[p.id] : '', n: p.n },
				geometry: { type: 'Point' as const, coordinates: p.c },
			};
		}),
	};
}

function linkGeoJSON() {
	return {
		type: 'FeatureCollection' as const,
		features: LINKS.map((l) => ({
			type: 'Feature' as const,
			properties: { id: l.id },
			geometry: { type: 'LineString' as const, coordinates: l.c },
		})),
	};
}

// a slot is a little wider than a line, so neighbours keep a visible gap
const offset: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 10, ['*', ['get', 'o'], 2.6], 13, ['*', ['get', 'o'], 4], 16, ['*', ['get', 'o'], 6.4]];

export function mountGeoMap(el: HTMLElement, key: string, onSeg: (id: string) => void, onSt: (id: number) => void) {
	const t = SUBWAY_MAP_TOKENS;

	const style = key
		? menuBasemap(key, t)
		: { version: 8 as const, sources: {}, layers: [{ id: 'ground', type: 'background' as const, paint: { 'background-color': t.land } }] };

	const lons = STOPS.map((p) => p.c[0]), lats = STOPS.map((p) => p.c[1]);

	const map = new maplibregl.Map({
		container: el,
		// SAFETY: both branches are complete v8 styles; TS only loses the layer-type literals.
		style: style as maplibregl.StyleSpecification,
		bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
		fitBoundsOptions: { padding: 30 },
		maxBounds: [-74.6, 40.35, -73.4, 41.05],
		dragRotate: false,
		pitchWithRotate: false,
	});

	map.touchZoomRotate.disableRotation();
	map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

	let loaded = false, pending: Marks | null = null;

	map.on('load', () => {
		map.addSource('seg', { type: 'geojson', data: lineGeoJSON(), promoteId: 'id' });
		map.addSource('st', { type: 'geojson', data: stationGeoJSON(), promoteId: 'id' });

		map.addLayer({
			id: 'seg',
			type: 'line',
			source: 'seg',
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: {
				'line-color': ['case', on, ['get', 'color'], ['get', 'faded']],
				'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', on, 2.4, 2], 13, ['case', on, 3.6, 3], 16, ['case', on, 5.5, 4.6]],
				'line-offset': offset,
			},
		});

		map.addLayer({
			id: 'seg-hit',
			type: 'line',
			source: 'seg',
			paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 9, 'line-offset': offset },
		});

		// a complex's platforms joined by a walkway, drawn like the markers it links
		map.addSource('link', { type: 'geojson', data: linkGeoJSON(), promoteId: 'id' });

		const links: [string, number, string][] = [['link-edge', 7, EDGE], ['link', 4.4, t.land]];

		for (const [id, width, off] of links) {
			map.addLayer({
				id,
				type: 'line',
				source: 'link',
				layout: { 'line-cap': 'round' },
				paint: {
					'line-color': ['case', on, INK, off],
					'line-width': ['interpolate', ['linear'], ['zoom'], 11, width * 0.45, 16, width * 1.4],
				},
			});
		}

		map.addLayer({
			id: 'st',
			type: 'circle',
			source: 'st',
			paint: {
				'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['>', ['get', 'n'], 2], 3.2, 2.4], 16, ['case', ['>', ['get', 'n'], 2], 8, 6]],
				'circle-color': ['case', on, INK, t.land],
				'circle-stroke-color': ['case', on, INK, EDGE],
				'circle-stroke-width': 1.3,
			},
		});

		// labels need the tile server's glyphs, so only with a key
		if (key) {
			map.addLayer({
				id: 'st-label',
				type: 'symbol',
				source: 'st',
				minzoom: 13,
				layout: {
					'text-field': ['get', 'name'],
					'text-font': ['Noto Sans Medium'],
					'text-size': 11,
					'text-anchor': 'left',
					'text-offset': [0.9, 0],
					'text-optional': true,
				},
				paint: { 'text-color': '#d9d7d1', 'text-halo-color': t.land, 'text-halo-width': 1.5 },
			});
		}

		loaded = true;

		if (pending) show(pending);
	});

	// a station sits on top of its lines, so it wins a click
	function hitAt(p: maplibregl.Point) {
		const box: [maplibregl.PointLike, maplibregl.PointLike] = [[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]];
		const st = map.queryRenderedFeatures(box, { layers: ['st'] })[0];

		if (st) {
			// SAFETY: stationGeoJSON sets `id` to the numeric station id.
			return { kind: 'st' as const, id: st.properties.id as number };
		}

		const sg = map.queryRenderedFeatures(p, { layers: ['seg-hit'] })[0];

		// SAFETY: lineGeoJSON sets `id` to the string segment id.
		return sg ? { kind: 'seg' as const, id: sg.properties.id as string } : null;
	}

	map.on('click', (e) => {
		if (!loaded) return;
		const h = hitAt(e.point);

		if (h?.kind === 'st') onSt(h.id);
		else if (h) onSeg(h.id);
	});

	map.on('mousemove', (e) => {
		if (loaded) map.getCanvas().style.cursor = hitAt(e.point) ? 'pointer' : '';
	});

	function show(marks: Marks) {
		if (!loaded) { pending = marks;

 return; }

		map.removeFeatureState({ source: 'seg' });
		map.removeFeatureState({ source: 'st' });
		map.removeFeatureState({ source: 'link' });

		for (const id in marks.seg) map.setFeatureState({ source: 'seg', id }, { on: true });

		for (const id in marks.st) {
			map.setFeatureState({ source: 'st', id: Number(id) }, { on: true });
			map.setFeatureState({ source: 'link', id: Number(id) }, { on: true });
		}
	}

	return { show, resize: () => map.resize() };
}
