// The basemap, authored rather than borrowed.
//
// This is the part of the map that decides whether it looks like part of a menu
// or like an iframe someone dropped in the page, so none of it comes from a
// vendor's stock style. MapTiler supplies the vector tiles (the OpenMapTiles
// schema); every colour, width and label rule below is ours, and the palette is
// the one the section is already printed in — cream ground, ink brown, a faded
// green wash for water.
//
// WATER IS GREEN, WHICH IS THE ONE CHOICE PEOPLE QUESTION. Blue water on cream
// paper reads as a map that has been dropped into the page from somewhere else:
// it is the one hue in the default palette that no printed menu contains. A
// faded green-grey sits in the same family as the parks and lets the terracotta
// pins be the only saturated thing on the screen — which is the point, because
// the pins are the content and the basemap is the paper it is printed on.
//
// ROADS ARE DRAWN LIGHTER THAN THE LAND IS DARK. On a dark basemap you add
// light to show a road; on paper you take ink away. Majors are a warm cream
// with a hairline casing, minors barely separate from the ground — enough to
// recognise a street grid by, not enough to compete with a pin.
//
// The token names match the design bundle's basemap spec one for one, so the
// two can be diffed by eye.

export const MAP_TOKENS = {
	land: '#f2e7d2', // the paper the map is printed on
	water: '#c9d4c2', // a faded green wash — not blue
	park: '#dee5c3', // parks, cemeteries, green space
	roadMajor: '#e9d6ae', // arterials, bridges
	roadCasing: '#cbb389', // hairline casing on majors only
	roadMinor: '#efe4cd', // residential streets
	building: '#e6d8bc', // building fill, no stroke
	boundary: '#b8a180', // borough / state, dashed
	label: '#4a3626', // place and street labels
	labelHalo: '#f7f0e0', // 1.5px halo
	pinRing: '#2f1e12', // pin outline, and the fill of a worth-the-trip pin
} as const;

const TILES = 'https://api.maptiler.com/tiles/v3/tiles.json';
const GLYPHS = 'https://api.maptiler.com/fonts/{fontstack}/{range}.pbf';

/**
 * The style JSON, built around a key.
 *
 * The key is a PUBLIC one — it is compiled into the page and every tile request
 * carries it, which is how MapLibre works and why MapTiler expects you to
 * restrict the key to your own domains in their dashboard rather than to keep
 * it secret. Treat the domain allowlist as the actual control.
 *
 * Labels are set in Noto Sans because that is what the tile server has glyphs
 * for; Archivo would need a self-hosted glyph range, which is a lot of pipeline
 * for type that renders at 11px under a pin. The label COLOUR and halo are ours,
 * which is what actually makes them look set rather than default.
 */
export function menuBasemap(key: string) {
	const t = MAP_TOKENS;
	return {
		version: 8 as const,
		name: "Jason's restaurant log",
		glyphs: `${GLYPHS}?key=${key}`,
		sources: {
			base: { type: 'vector' as const, url: `${TILES}?key=${key}` },
		},
		layers: [
			{ id: 'ground', type: 'background' as const, paint: { 'background-color': t.land } },
			{
				id: 'water',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'water',
				paint: { 'fill-color': t.water },
			},
			{
				id: 'park',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'park',
				paint: { 'fill-color': t.park, 'fill-opacity': 0.9 },
			},
			{
				// Buildings only once you are close enough for them to mean
				// something; at city zoom they are noise the pins have to fight.
				id: 'building',
				type: 'fill' as const,
				source: 'base',
				'source-layer': 'building',
				minzoom: 14,
				paint: {
					'fill-color': t.building,
					'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 16, 1],
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
					'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 1.6, 16, 9],
				},
			},
			{
				id: 'road-minor',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'transportation',
				filter: ['in', 'class', 'minor', 'service', 'street', 'residential'],
				minzoom: 12,
				paint: {
					'line-color': t.roadMinor,
					'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.4, 18, 6],
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
					'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 0.8, 16, 7],
				},
			},
			{
				id: 'boundary',
				type: 'line' as const,
				source: 'base',
				'source-layer': 'boundary',
				filter: ['<=', 'admin_level', 6],
				paint: {
					'line-color': t.boundary,
					'line-width': 0.8,
					'line-dasharray': [3, 2],
					'line-opacity': 0.7,
				},
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
					'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13],
					'text-letter-spacing': 0.14,
					'text-transform': 'uppercase' as const,
					'text-max-width': 8,
				},
				paint: {
					'text-color': t.label,
					'text-halo-color': t.labelHalo,
					'text-halo-width': 1.5,
				},
			},
			{
				// Street names only when zoomed in past the point where the
				// neighbourhood label alone stops being enough.
				id: 'label-street',
				type: 'symbol' as const,
				source: 'base',
				'source-layer': 'transportation_name',
				minzoom: 14,
				layout: {
					'text-field': ['get', 'name'],
					'text-font': ['Noto Sans Regular'],
					'text-size': 10.5,
					'symbol-placement': 'line' as const,
				},
				paint: {
					'text-color': t.label,
					'text-halo-color': t.labelHalo,
					'text-halo-width': 1.2,
					'text-opacity': 0.85,
				},
			},
		],
	};
}
