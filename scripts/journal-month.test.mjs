// The combined month card's one piece of real arithmetic: the size weights.
//
// What is worth failing over is the CALIBRATION, not the drawing — that marks
// stay in the right order and the right ratio as the constants get tuned, that
// a snack is smaller than a meal, that boosted reading lands where it should,
// and that a day's cluster is built biggest-first from every track at once.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/journal-month.test.mjs
import assert from 'node:assert/strict';
import {
	BOOK_BOOST,
	FILM_MINUTES,
	MARK_MAX,
	MARK_MIN,
	MEAL_MINUTES,
	SNACK_MINUTES,
	activityItems,
	bookItems,
	buildCells,
	filmItems,
	headline,
	isSnack,
	clusterScale,
	markSize,
	mealItems,
	summarise,
} from '../src/lib/journal-month.ts';

// 1. Area, not width. Four times the minutes is twice the mark — the whole
//    reason markSize takes a square root. Checked away from both clamps.
const small = markSize(30);
const big = markSize(120);
assert.ok(Math.abs(big / small - 2) < 0.06, `4x time should be ~2x side, got ${big / small}`);

// 2. The clamps hold at both ends, so a one-minute entry is still a picture and
//    a ten-hour day doesn't evict the rest of its cluster.
assert.equal(markSize(0), MARK_MIN);
assert.equal(markSize(1), MARK_MIN);
assert.equal(markSize(600), MARK_MAX);
assert.ok(markSize(MEAL_MINUTES) > MARK_MIN && markSize(MEAL_MINUTES) < MARK_MAX);

// 3. Ordering across the four tracks at their real weights: a snack is the
//    smallest thing on the card, a meal beats it, a feature beats that. If a
//    constant is retuned into a nonsense order this is what says so.
assert.ok(markSize(SNACK_MINUTES) < markSize(MEAL_MINUTES));
assert.ok(markSize(MEAL_MINUTES) < markSize(FILM_MINUTES));
// ...and the snack/meal split reads as "smaller thing", not "different kind of
// thing" — a 3:1 time ratio must stay under 2x across.
assert.ok(markSize(MEAL_MINUTES) / markSize(SNACK_MINUTES) < 2);

// 4. The snack classifier. It reads name, cuisines and tags; brunch and bars
//    are meals on purpose.
assert.ok(isSnack({ restaurant_name: 'Balthazar Bakery' }));
assert.ok(isSnack({ restaurant_name: 'x', cuisines: ['Dessert'] }));
assert.ok(isSnack({ restaurant_name: 'x', tags: ['coffee'] }));
assert.ok(!isSnack({ restaurant_name: 'Gramercy Tavern', cuisines: ['American'] }));
assert.ok(!isSnack({ restaurant_name: 'Sunday in Brooklyn', tags: ['brunch'] }));
assert.ok(!isSnack({ restaurant_name: 'Attaboy', cuisines: ['Cocktail bar'] }));

// 5. The book boost is applied once, to measured seconds.
const [chapter] = bookItems(
	[{ book_id: 1, day: '2026-03-04', seconds: 3600 }],
	[{ id: 1, title: 'Piranesi', authors: 'Susanna Clarke', cover_url: null, is_public: true }],
);
assert.equal(chapter.minutes, 60 * BOOK_BOOST);
assert.equal(chapter.title, 'Piranesi');

// 6. A private book keeps its day and its size, and gives up everything else —
//    the day it was read is not the secret, the book is.
const [secret] = bookItems(
	[{ book_id: 2, day: '2026-03-04', seconds: 1800 }],
	[{ id: 2, title: '', authors: null, cover_url: null, is_public: false }],
);
assert.equal(secret.minutes, 30 * BOOK_BOOST);
assert.equal(secret.href, null);
assert.equal(secret.image, null);
assert.notEqual(secret.title, '');

// 7. Activities use moving time when they have it, elapsed when they don't —
//    a ride with a long coffee stop was a ride, not three hours.
const moves = activityItems([
	{ id: 1, sport: 'ride', title: 'Bear Mtn', local_date: '2026-03-04', moving_seconds: 7200, elapsed_seconds: 10800 },
	{ id: 2, sport: 'run', title: 'Loop', local_date: '2026-03-05', moving_seconds: null, elapsed_seconds: 1800 },
]);
assert.equal(moves[0].minutes, 120);
assert.equal(moves[1].minutes, 30);
assert.ok(moves[0].icon, 'an activity always has a glyph to draw');

// 8. A day is a cluster of every track at once, biggest first — the one thing
//    this card does that none of the other four can.
const items = [
	...filmItems([
		{ id: 9, watched_date: '2026-03-04', tmdb_id: 1, title: 'Chungking Express', release_year: 1994, poster_path: '/a.jpg', runtime: 102, rating: 4.5 },
	]),
	...mealItems([
		{ id: 7, visited_on: '2026-03-04', restaurant_name: 'Fan Fried Rice', cuisines: ['Chinese'], tags: [], neighborhood: 'Chinatown', photos: [] },
		{ id: 8, visited_on: '2026-03-04', restaurant_name: 'Fay Da Bakery', cuisines: ['Bakery'], tags: [], neighborhood: 'Chinatown', photos: [] },
	]),
	...chapterOf(),
	...moves.slice(0, 1),
];
function chapterOf() {
	return bookItems(
		[{ book_id: 1, day: '2026-03-04', seconds: 3600 }],
		[{ id: 1, title: 'Piranesi', authors: 'Susanna Clarke', cover_url: null, is_public: true }],
	);
}

const cells = buildCells('2026-03', items);
assert.equal(cells.length % 7, 0, 'the grid is whole weeks');
const march4 = cells.find((c) => !c.outside && c.date === 4);
assert.equal(march4.marks.length, 5, 'the ride, the film, the chapter and both meals');
assert.deepEqual(
	march4.marks.map((m) => m.track),
	['move', 'film', 'book', 'meal', 'meal'],
	'biggest first: 120min ride, 102min film, 78min chapter, 60min meal, 20min snack',
);
assert.deepEqual(march4.tracks, ['film', 'book', 'meal', 'move'], 'the day touched all four');
assert.ok(march4.marks[0].size > march4.marks[4].size);
// Every mark tilts, and none of them tilts flat.
assert.ok(march4.marks.every((m) => Math.abs(m.tilt) > 0.1 && Math.abs(m.tilt) < 5));

// 9. A day outside the month, and padding cells, hold nothing.
const march5 = cells.find((c) => !c.outside && c.date === 5);
assert.equal(march5.marks.length, 0);
assert.ok(cells.some((c) => c.outside && c.marks.length === 0));
// An item from another month never lands in this grid.
assert.equal(buildCells('2026-04', items).every((c) => c.marks.length === 0), true);

// 10. The summary is one figure per track, in hours, in TRACKS order.
const figures = summarise(items);
assert.deepEqual(figures.map((f) => f.label), ['Films', 'Books', 'Meals', 'Activities']);
assert.equal(figures[2].value, '1h', '60 + 20 minutes of eating');
assert.equal(headline(items).days, 1);

// 11. A busy day shrinks as a whole; an ordinary one doesn't shrink at all.
//     Shrinking must not reorder or re-rank anything — every ratio inside the
//     day survives, which is the only reason this is allowed to happen.
assert.equal(clusterScale([]), 1);
assert.equal(clusterScale([{ size: 50 }]), 1);
assert.equal(clusterScale([{ size: 38 }, { size: 22 }]), 1);
const busy = [{ size: 67 }, { size: 54 }, { size: 53 }, { size: 45 }, { size: 38 }];
const s = clusterScale(busy);
assert.ok(s > 0.8 && s < 1, `the busiest day should tighten, not collapse — got ${s}`);
// The shrunk cluster fits. That day wraps into three rows (67+54 and 53+45 each
// fill the ~120px width, then 38 alone), and the marks' -3px margins pull each
// row junction 6px into the one above — so the stack is the three row heights
// less 12px, against the 137px a cell has inside at the shortest aspect.
const shrunk = busy.map((m) => m.size * s);
const stacked = shrunk[0] + shrunk[2] + shrunk[4] - 12;
assert.ok(stacked <= 137, `three wrapped rows must fit the cell, got ${stacked.toFixed(1)}px`);
// And a genuinely absurd day still leaves marks big enough to see.
assert.ok(clusterScale(Array.from({ length: 12 }, () => ({ size: MARK_MAX }))) * MARK_MAX > 8);

console.log('journal-month: ok');
