// recipes.json validation and the /recipes filters.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/recipes.test.mjs
import assert from 'node:assert/strict';
import { filterRecipes, handsOnMinutes, parseRecipeQuery, recipeIndexView, recipesFile, totalMinutes } from '../src/lib/recipes.ts';

const parseRecipes = (data) => recipesFile.parse(data);

const entry = (o = {}) => ({
	id: 'DdmFAorRxJM',
	title: 'Roast chicken',
	source_url: 'https://www.instagram.com/reel/DdmFAorRxJM/',
	type: 'main',
	status: 'full',
	prep_minutes: 5,
	cook_active_minutes: 5,
	cook_waiting_minutes: 0,
	key_ingredients: ['Chicken', 'onion'],
	...o,
});

// A good entry is normalised.
const { recipes: [ok] } = parseRecipes([entry({ creator: '@zest', cuisine: 'American', tags: ['One-Pan', 'one-pan', 'american', 'main'] })]);

assert.equal(ok.creator, 'zest');

assert.equal(ok.cuisine, 'american');

assert.deepEqual(ok.key_ingredients, ['chicken', 'onion']);

assert.deepEqual(ok.tags, ['one-pan']);

assert.equal(ok.site_url, null);

assert.equal(ok.added, '2026-09-22', 'the date comes from the shortcode');

assert.equal(ok.type, 'main');

assert.equal(ok.completeness, 'full');

const linked = parseRecipes([entry({ source_links: ['http://a.example', 'https://b.example'], notes: ['One.', 'Two.'] })]).recipes[0];

assert.equal(linked.site_url, 'https://b.example', 'the first https link');

assert.equal(linked.note, 'One. Two.');

// A bad entry is skipped with a reason, and the good ones still go through.
const mixed = parseRecipes([
	entry(),
	entry(),
	entry({ id: 'aaaaaaaaaaa', source_url: 'javascript:alert(1)' }),
	entry({ id: 'bbbbbbbbbbb', type: ' ' }),
	entry({ id: 'ccccccccccc', status: 'constructor' }),
	entry({ id: 'ddddddddddd', prep_minutes: 1.5 }),
	entry({ id: 'fffffffffff', cook_waiting_minutes: undefined }),
	entry({ id: '../x/../y/z' }),
	entry({ id: 'x'.repeat(40) }),
	entry({ id: 'eeeeeeeeeee', key_ingredients: undefined }),
	null,
]);

assert.equal(mixed.recipes.length, 1);

assert.equal(mixed.skipped.length, 10);

assert.equal(mixed.skipped[0].reason, 'duplicate id');

assert.throws(() => parseRecipes({ recipes: [] }), /expected array/);

const times = { prep_minutes: 10, cook_active_minutes: 5, cook_waiting_minutes: 60 };

assert.equal(handsOnMinutes(times), 15);

assert.equal(totalMinutes(times), 75);

const row = (id, o) => parseRecipes([entry({ id, ...o })]).recipes[0];

const all = [
	row('aaaaaaaaaaa', { type: 'main', cuisine: 'thai', key_ingredients: ['chicken', 'basil'], prep_minutes: 5, cook_active_minutes: 5, cook_waiting_minutes: 5 }),
	row('bbbbbbbbbbb', { type: 'main', cuisine: 'italian', key_ingredients: ['chicken', 'lemon'], prep_minutes: 5, cook_active_minutes: 5, cook_waiting_minutes: 480 }),
	row('ccccccccccc', { type: 'rice', cuisine: 'thai', key_ingredients: ['rice', 'basil'], prep_minutes: 20, cook_active_minutes: 20, status: 'partial' }),
];

const ids = (qs) => filterRecipes(all, parseRecipeQuery(new URLSearchParams(qs))).map((r) => r.id[0]);

assert.deepEqual(ids(''), ['a', 'b', 'c']);

assert.deepEqual(ids('type=main&type=rice'), ['a', 'b', 'c'], 'types widen');

assert.deepEqual(ids('ingredient=chicken&ingredient=basil'), ['a'], 'ingredients narrow');

assert.deepEqual(ids('max=15'), ['a'], 'total counts the waiting');

assert.deepEqual(ids('hands=15'), ['a', 'b'], 'hands-on does not');

assert.deepEqual(ids('max=7'), ['a', 'b', 'c'], 'a limit that is not offered is ignored');

assert.deepEqual(ids('full=1'), ['a', 'b']);

assert.deepEqual(ids('q=THAI+basil'), ['a', 'c']);

const view = recipeIndexView(all, new URLSearchParams('cuisine=thai&ingredient=basil'));

// The cuisine group ignores its own selection; the ingredient group counts results.
assert.deepEqual(view.cuisines.map((c) => [c.label, c.count, c.on]), [['thai', 2, true]]);

assert.equal(view.ingredients.find((c) => c.label === 'basil').count, 2);

assert.ok(view.ingredients.find((c) => c.label === 'basil').href.includes('cuisine=thai'));

assert.ok(!view.ingredients.find((c) => c.label === 'basil').href.includes('ingredient'), 'a selected chip links to its removal');

assert.equal(view.active.length, 2);

console.log('recipes: ok');
