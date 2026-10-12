// /subway's "Map" view: the diagram's own stations and per-service segments
// (same ids, so the same saved log) drawn over a real map of the city.
//
// Positions come from subway-geo.js (each schematic station matched to its MTA
// stop). Segments are straight station-to-station chords — at subway stop
// spacing that is close enough to the track to read as the line.
// ponytail: chords, not track shapes; use GTFS shapes.txt if a curve ever matters.
//
// Parallel services fan apart with `line-offset`, which is in screen pixels, so
// the bundle keeps a constant on-screen width at any zoom — the same trick the
// SVG diagram does by hand. Offset follows the line's direction, so every chord
// is oriented into one half-plane first; otherwise a segment stored a→b and its
// neighbour stored b→a would offset to opposite sides and cross.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// See RestaurantMap.astro: the tile worker has to go through Vite's worker build.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { menuBasemap, SUBWAY_MAP_TOKENS } from '../lib/map-style';
import { SEGMENTS, STATIONS } from './subway-data.js';
import { GEO } from './subway-geo.js';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

type Marks = { st: Record<string, 1>; seg: Record<string, 1> };

const on: maplibregl.ExpressionSpecification = ['boolean', ['feature-state', 'on'], false];

function lineGeoJSON() {
	return {
		type: 'FeatureCollection' as const,
		features: SEGMENTS.map((sg) => {
			let a = GEO[sg.a], b = GEO[sg.b];

			// keep every chord heading into the north-east half-plane (see top)
			if (b[0] - a[0] + (b[1] - a[1]) < 0) [a, b] = [b, a];

			return {
				type: 'Feature' as const,
				properties: { id: sg.id, o: sg.o, color: sg.color },
				geometry: { type: 'LineString' as const, coordinates: [a, b] },
			};
		}),
	};
}

function stationGeoJSON() {
	return {
		type: 'FeatureCollection' as const,
		features: STATIONS.map((s) => ({
			type: 'Feature' as const,
			properties: { id: s.id, name: s.name, n: s.svcs.length },
			geometry: { type: 'Point' as const, coordinates: GEO[s.id] },
		})),
	};
}

const offset: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 10, ['*', ['get', 'o'], 2.6], 16, ['*', ['get', 'o'], 6]];

export function mountGeoMap(el: HTMLElement, key: string, onSeg: (id: string) => void, onSt: (id: number) => void) {
	const t = SUBWAY_MAP_TOKENS;

	const style = key
		? menuBasemap(key, t)
		: { version: 8 as const, sources: {}, layers: [{ id: 'ground', type: 'background' as const, paint: { 'background-color': t.land } }] };

	const lons = Object.values(GEO).map((p) => p[0]), lats = Object.values(GEO).map((p) => p[1]);

	const map = new maplibregl.Map({
		container: el,
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
				'line-color': ['get', 'color'],
				'line-opacity': ['case', on, 1, 0.32],
				'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', on, 2.6, 2], 16, ['case', on, 6, 4.5]],
				'line-offset': offset,
			},
		});

		map.addLayer({
			id: 'seg-hit',
			type: 'line',
			source: 'seg',
			paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 9, 'line-offset': offset },
		});

		map.addLayer({
			id: 'st',
			type: 'circle',
			source: 'st',
			paint: {
				'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['>', ['get', 'n'], 2], 3.2, 2.4], 16, ['case', ['>', ['get', 'n'], 2], 8, 6]],
				'circle-color': ['case', on, '#26231f', '#ffffff'],
				'circle-stroke-color': ['case', on, '#26231f', '#7a7264'],
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
				paint: { 'text-color': '#2a2620', 'text-halo-color': t.land, 'text-halo-width': 1.5 },
			});
		}

		loaded = true;

		if (pending) show(pending);
	});

	// a station sits on top of its lines, so it wins a click
	function hitAt(p: maplibregl.Point) {
		const box: [maplibregl.PointLike, maplibregl.PointLike] = [[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]];
		const st = map.queryRenderedFeatures(box, { layers: ['st'] })[0];

		if (st) return { kind: 'st' as const, id: st.properties.id as number };
		const sg = map.queryRenderedFeatures(p, { layers: ['seg-hit'] })[0];

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
		if (!loaded) { pending = marks; return; }

		map.removeFeatureState({ source: 'seg' });
		map.removeFeatureState({ source: 'st' });

		for (const id in marks.seg) map.setFeatureState({ source: 'seg', id }, { on: true });

		for (const id in marks.st) map.setFeatureState({ source: 'st', id: Number(id) }, { on: true });
	}

	return { show, resize: () => map.resize() };
}
