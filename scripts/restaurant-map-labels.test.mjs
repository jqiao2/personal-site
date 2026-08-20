// The map's place-label layer, checked against MapLibre's own style spec.
//
// The layer is declarative — MapLibre does the collision work — so what is
// worth testing is the declaration: that the spec is valid at all, and that
// the sort key really does rank worth-the-trip above everything else, since
// that is the rule deciding which name survives when two labels overlap. Both
// are read out of RestaurantMap.astro rather than restated here, so this fails
// if the component drifts.
//
// Run: node scripts/restaurant-map-labels.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { validateStyleMin, expression } from '@maplibre/maplibre-gl-style-spec';
import { menuBasemap, MAP_TOKENS } from '../src/lib/map-style.ts';

const src = readFileSync(new URL('../src/components/RestaurantMap.astro', import.meta.url), 'utf8')
	.split('\r\n')
	.join('\n');

/** The balanced `{...}` or `[...]` literal starting at or after `from`. */
function balanced(from, open, close) {
	const start = src.indexOf(open, from);
	assert.ok(start > 0, `no ${open} after index ${from}`);
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src[i] === open) depth++;
		else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
	}
	throw new Error('unbalanced literal');
}

const labelZoom = Number(/const LABEL_ZOOM = (\d+)/.exec(src)[1]);
const sortSrc = balanced(src.indexOf('const LABEL_SORT'), '[', ']');
const sourceSrc = balanced(src.indexOf("map.addSource('place-labels'"), '{', '}');
const layerSrc = balanced(src.indexOf('map.addLayer('), '{', '}').replace('LABEL_SORT', sortSrc);

/** The literals are TypeScript; `as const` is the only annotation in them. */
const evalIn = (js, scope) =>
	new Function(...Object.keys(scope), `return (${js.replace(/ as const/g, '')});`)(
		...Object.values(scope),
	);

/** Stands in for the pins the component serialises into its config tag. */
const samplePoints = [
	{ name: 'Ba Xuyên', lng: -74.0161, lat: 40.6387, trip: true, visits: 11 },
	{ name: 'Veselka', lng: -73.9866, lat: 40.7288, trip: false, visits: 2 },
];

// `cfg` is what the component reads its palette and its pins off.
const cfg = { tokens: MAP_TOKENS, points: samplePoints };
const source = evalIn(sourceSrc, { cfg });
const layer = evalIn(layerSrc, { cfg, LABEL_ZOOM: labelZoom });
const sortKey = evalIn(sortSrc, {});

// 1. Source and layer are valid MapLibre, against the style they are added to.
{
	const style = menuBasemap('test');
	const errors = validateStyleMin({
		...style,
		sources: { ...style.sources, 'place-labels': source },
		layers: [...style.layers, layer],
	});
	assert.deepEqual(
		errors.map((e) => `${e.line ?? ''} ${e.message}`),
		[],
		'label layer failed style validation',
	);
	assert.equal(source.data.features.length, samplePoints.length, 'every pin becomes a label');
	assert.deepEqual(source.data.features[0].properties, {
		name: 'Ba Xuyên',
		trip: true,
		visits: 11,
	});
}

// 2. Names only from LABEL_ZOOM up — far out, a name per pin is a smear.
assert.equal(layer.minzoom, labelZoom);
assert.ok(labelZoom >= 12, 'labels should not appear at city-wide zoom');

// 3. Collisions are MapLibre's to resolve, but the ORDER is ours: lower
//    sort-key is placed first and so survives. Worth-the-trip outranks
//    everything, even a place with far more visits.
{
	const compiled = expression.createExpression(sortKey, {
		type: 'number',
		'property-type': 'data-driven',
		expression: { interpolated: false, parameters: ['feature'] },
	});
	assert.equal(compiled.result, 'success', 'sort key is not a valid expression');

	const rank = (trip, visits) =>
		compiled.value.evaluate({ zoom: 15 }, { properties: { trip, visits } });

	assert.ok(rank(true, 0) < rank(false, 999), 'worth-the-trip must outrank any nearby place');
	assert.ok(rank(true, 5) < rank(true, 1), 'within a band, more visits ranks higher');
	assert.ok(rank(false, 5) < rank(false, 1), 'and the same holds for nearby places');
}

// 4. The label sits below the pin's point, not over the 34px marker above it.
assert.equal(layer.layout['text-anchor'], 'top');
assert.ok(layer.layout['text-offset'][1] > 0, 'offset must push the label downward');
assert.equal(layer.layout['text-allow-overlap'], false, 'overlapping labels defeat the point');

console.log('restaurant map labels: ok');
