// /log's paging: the pager's numbers, and that pages tile the sorted log.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/journal-log.test.mjs
import assert from 'node:assert/strict';
import {
	PAGE_SIZE,
	compareEntries,
	pageCount,
	pageSlice,
	pagerNumbers,
} from '../src/lib/journal-log-page.ts';

// Pager: first, last, a window of two, gaps only where more than one page is skipped.
assert.deepEqual(pagerNumbers(1, 1), [1]);

assert.deepEqual(pagerNumbers(1, 5), [1, 2, 3, 4, 5]);

assert.deepEqual(pagerNumbers(2, 40), [1, 2, 3, 4, null, 40]);

assert.deepEqual(pagerNumbers(5, 40), [1, 2, 3, 4, 5, 6, 7, null, 40]);

assert.deepEqual(pagerNumbers(20, 40), [1, null, 18, 19, 20, 21, 22, null, 40]);

assert.deepEqual(pagerNumbers(40, 40), [1, null, 38, 39, 40]);

// Counts.
assert.equal(pageCount(0), 1);

assert.equal(pageCount(PAGE_SIZE), 1);

assert.equal(pageCount(PAGE_SIZE + 1), 2);

// Order: newest day first, then last logged, then a stable tie-break.
const log = [
	{ track: 'film', key: '1', day: '2026-09-01', logged: '2026-09-01T20:00' },
	{ track: 'book', key: '9:2026-09-02', day: '2026-09-02', logged: '2026-09-02' },
	{ track: 'move', key: '4', day: '2026-09-02', logged: '2026-09-02T07:00' },
	{ track: 'meal', key: '1', day: '2026-09-01', logged: '2026-09-01T20:00' },
].sort(compareEntries);

assert.deepEqual(
	log.map((e) => `${e.track}:${e.key}`),
	['move:4', 'book:9:2026-09-02', 'film:1', 'meal:1'],
);

// Pages tile: every entry on exactly one page, in order.
const many = Array.from({ length: 47 }, (_, i) => i);

const pages = pageCount(many.length);

assert.equal(pages, 4);

assert.deepEqual(
	Array.from({ length: pages }, (_, i) => pageSlice(many, i + 1)).flat(),
	many,
);

assert.deepEqual(pageSlice(many, 5), []);

console.log('journal-log: ok');
