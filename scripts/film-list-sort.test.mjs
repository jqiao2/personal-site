// The runnable check on a film list's sort orders (src/lib/film-list-sort.ts).
//
//   node --import ./scripts/ts-hook.mjs scripts/film-list-sort.test.mjs
import assert from 'node:assert/strict';
import { parseListSort, sortListFilms } from '../src/lib/film-list-sort.ts';

const films = [
	{ title: 'b', release_year: 1999, rating: null, added_at: '2026-01-02' },
	{ title: 'A', release_year: null, rating: 4, added_at: '2026-01-03' },
	{ title: 'c', release_year: 2010, rating: 3, added_at: '2026-01-01' },
];

const titles = (sort) => sortListFilms(films, sort).map((f) => f.title).join('');

assert.equal(titles(''), 'bAc', 'own order untouched');

assert.equal(titles('title'), 'Abc', 'case-insensitive A–Z');

assert.equal(titles('year'), 'cbA', 'newest first, undated last');

assert.equal(titles('rating'), 'Acb', 'highest first, unrated last');

assert.equal(titles('added'), 'Abc', 'most recently added first');

assert.equal(films[0].title, 'b', 'input not mutated');

assert.equal(parseListSort('rating', true), 'rating');

assert.equal(parseListSort('rating', false), '', 'hand-picked lists have no ratings');

assert.equal(parseListSort('added', true), '', 'smart lists have no added date');

assert.equal(parseListSort('nonsense', false), '');

console.log('film-list-sort: ok');
