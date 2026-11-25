// Letterboxd watchlist parsing and the sync plan.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/letterboxd-watchlist.test.mjs
import assert from 'node:assert/strict';
import { parseFilmTmdbId, parseWatchlistPage, planWatchlistSync } from '../src/lib/letterboxd.ts';

// A watchlist grid item, as Letterboxd served it on 2026-11-25 (trimmed).
const poster = (slug) => `<li class="griditem">
	<div class="react-component" data-component-class="LazyPoster" data-item-name="X (1939)" data-item-slug="${slug}" data-item-link="/film/${slug}/" data-target-link="/film/${slug}/" data-details-endpoint="/film/${slug}/json/"> <div class="poster film-poster"></div> </div>
</li>`;

assert.deepEqual(parseWatchlistPage(poster('the-rules-of-the-game') + poster('3-idiots')), ['the-rules-of-the-game', '3-idiots']);

// Older markup.
assert.deepEqual(parseWatchlistPage('<div data-film-slug="jaws"></div>'), ['jaws']);

// A page past the end is a normal page with an empty grid.
assert.deepEqual(parseWatchlistPage('<html><body class="list-page"><ul class="grid"></ul></body></html>'), []);

assert.equal(parseFilmTmdbId('<body class="film backdropped" data-type="film" data-tmdb-type="movie" data-tmdb-id="238">'), 238);

// A miniseries listed as a film: empty id.
assert.equal(parseFilmTmdbId('<body class="film backdropped" data-type="film" data-tmdb-type="movie" data-tmdb-id="">'), null);

assert.equal(parseFilmTmdbId('<body data-tmdb-type="tv" data-tmdb-id="1399">'), null);

assert.throws(() => parseFilmTmdbId('Just a moment...'));

// The plan.
const row = (movieId, tmdbId, fromLetterboxd) => ({ movieId, tmdbId, fromLetterboxd });

const plan = planWatchlistSync(
	[10, 20, 30, 40],
	[
		row(1, 20, true), // on both, already Letterboxd's
		row(2, 30, false), // on both, added on the site first: claimed
		row(3, 50, true), // dropped on Letterboxd: removed
		row(4, 60, false), // the site's own: kept
	],
	new Set([40]), // watched: not added back
);

assert.deepEqual(plan, { add: [10], claim: [2], remove: [3] });

// Letterboxd order is kept for additions.
assert.deepEqual(planWatchlistSync([3, 1, 2], [], new Set()).add, [3, 1, 2]);

console.log('letterboxd watchlist: ok');
