// recipes.json validation and the /recipes filters.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/recipes.test.mjs
import assert from 'node:assert/strict';
import { filterRecipes, parseRecipeQuery, recipeIndexView, recipesFile, totalMinutes } from '../src/lib/recipes.ts';

const parseRecipes = (data) => recipesFile.parse(data);

const entry = (o = {}) => ({
	id: 'DdmFAorRxJM',
	title: 'Roast chicken',
	added: '2026-11-04',
	source_url: 'https://www.instagram.com/reel/DdmFAorRxJM/',
	course: 'main',
	completeness: 'full',
	key_ingredients: ['Chicken', 'onion'],
	...o,
});

// A good entry is normalised.
const { recipes: [ok] } = parseRecipes([entry({ creator: '@zest', cuisine: 'American', tags: ['One-Pan', 'one-pan'] })]);

assert.equal(ok.creator, 'zest');

assert.equal(ok.cuisine, 'american');

assert.deepEqual(ok.key_ingredients, ['chicken', 'onion']);

assert.deepEqual(ok.tags, ['one-pan']);

assert.equal(ok.site_url, null);

// A bad entry is skipped with a reason, and the good ones still go through.
const mixed = parseRecipes([
	entry(),
	entry(),
	entry({ id: 'a', source_url: 'javascript:alert(1)' }),
	entry({ id: 'b', site_url: 'http://example.com' }),
	entry({ id: 'c', course: 'soup' }),
	entry({ id: 'd', completeness: 'constructor' }),
	entry({ id: 'e', prep_minutes: 1.5 }),
	entry({ id: '../x' }),
	entry({ id: 'f', key_ingredients: undefined }),
	null,
]);

assert.equal(mixed.recipes.length, 1);

assert.equal(mixed.skipped.length, 9);

assert.equal(mixed.skipped[0].reason, 'duplicate id');

assert.throws(() => parseRecipes({ recipes: [] }), /expected array/);

// Unknown time only stays unknown; a no-cook recipe counts.
assert.equal(totalMinutes({ prep_minutes: 10, cook_minutes: null }), null);

assert.equal(totalMinutes({ prep_minutes: 10, cook_minutes: 0 }), 10);

const row = (id, o) => parseRecipes([entry({ id, ...o })]).recipes[0];

const all = [
	row('a', { course: 'main', cuisine: 'thai', key_ingredients: ['chicken', 'basil'], prep_minutes: 5, cook_minutes: 10 }),
	row('b', { course: 'main', cuisine: 'italian', key_ingredients: ['chicken', 'lemon'], prep_minutes: 20, cook_minutes: 40 }),
	row('c', { course: 'rice', cuisine: 'thai', key_ingredients: ['rice', 'basil'], completeness: 'partial' }),
];

const ids = (qs) => filterRecipes(all, parseRecipeQuery(new URLSearchParams(qs))).map((r) => r.id);

assert.deepEqual(ids(''), ['a', 'b', 'c']);

assert.deepEqual(ids('course=main&course=rice'), ['a', 'b', 'c'], 'courses widen');

assert.deepEqual(ids('ingredient=chicken&ingredient=basil'), ['a'], 'ingredients narrow');

assert.deepEqual(ids('max=15'), ['a'], 'an unknown time does not pass a limit');

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
