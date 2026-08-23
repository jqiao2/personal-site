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
	ASPECT_MAX,
	ASPECT_MIN,
	MARK_MAX,
	MARK_MIN,
	PRINT_ASPECT,
	MEAL_MINUTES,
	SNACK_MINUTES,
	activityItems,
	bookItems,
	buildCells,
	filmItems,
	isSnack,
	dayLayer,
	markBox,
	markSize,
	placeCluster,
	mealItems,
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
assert.equal(markSize(900), MARK_MAX);
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
	{ id: 1, sport: 'ride', title: 'Bear Mtn', local_date: '2026-03-04', moving_seconds: 7200, elapsed_seconds: 10800, route_path: 'M6 6 L94 94' },
	{ id: 2, sport: 'swim', title: 'Pool', local_date: '2026-03-05', moving_seconds: null, elapsed_seconds: 1800, route_path: null },
]);
assert.equal(moves[0].minutes, 120);
assert.equal(moves[1].minutes, 30);
// A ride with GPS draws its route and nothing else; a pool swim has no route to
// draw and falls back to its sport glyph. Never both — they are two faces.
assert.equal(moves[0].route, 'M6 6 L94 94');
assert.equal(moves[0].icon, null);
assert.equal(moves[1].route, null);
assert.ok(moves[1].icon, 'a no-GPS activity still has a face');

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

// 11. A mark's box spends its area at the thing's real shape. AREA is the
//     invariant: a 2:3 poster and a square photograph standing for the same two
//     hours must cover the same paper, or the card stops meaning what it says.
const square = markBox(60, 1);
assert.deepEqual(square, { w: 60, h: 60 });
const poster = markBox(60, PRINT_ASPECT);
assert.ok(poster.h > poster.w, 'a poster is taller than it is wide');
assert.ok(Math.abs(poster.w * poster.h - 60 * 60) / 3600 < 0.02, 'same area as the square');
const wide = markBox(60, 3 / 2);
assert.ok(Math.abs(wide.w * wide.h - 3600) / 3600 < 0.02);
// A panorama is clamped rather than drawn as a splinter, and a missing/zero
// aspect falls back to square instead of collapsing.
assert.equal(markBox(60, 12).w / markBox(60, 12).h <= ASPECT_MAX + 0.05, true);
assert.equal(markBox(60, 0.01).w / markBox(60, 0.01).h >= ASPECT_MIN - 0.05, true);
assert.deepEqual(markBox(60, 0), { w: 60, h: 60 });

// 12. A film mark carries the print ratio, a plate carries its own, and a
//     photograph with no recorded size falls back to square.
const [plate] = mealItems([
	{ id: 1, visited_on: '2026-03-04', restaurant_name: 'x', cuisines: [], tags: [], neighborhood: null, photos: [{ url: 'https://x/a.jpg', width: 1600, height: 1200 }] },
]);
assert.ok(Math.abs(plate.aspect - 4 / 3) < 1e-9);
const [noshot] = mealItems([
	{ id: 2, visited_on: '2026-03-04', restaurant_name: 'x', cuisines: [], tags: [], neighborhood: null, photos: [] },
]);
assert.equal(noshot.aspect, 1);

// 13. Later days paint over earlier ones, so the spill reads as things stuck in
//     over the course of the month rather than in an arbitrary order.
assert.ok(dayLayer(31) > dayLayer(30));
assert.ok(dayLayer(2) > dayLayer(1));

// 14. The pile is a cluster, not a row. The day's biggest print anchors the
//     middle and the rest scatter around it in two dimensions — the thing a
//     wrapping flex line structurally cannot do.
const pile = placeCluster(march4.marks);
assert.equal(pile.length, march4.marks.length);
assert.equal(pile[0].dx, 0, 'the main event anchors the centre');
assert.equal(pile[0].dy, 0);
// Nothing sits on top of anything else at the same spot.
const spots = new Set(pile.map((m) => `${m.dx},${m.dy}`));
assert.equal(spots.size, pile.length, 'every print gets its own place');
// Both axes are used — a row layout would leave dy flat.
assert.ok(pile.some((m) => Math.abs(m.dy) > 12), 'the pile uses the height of the day');
assert.ok(pile.some((m) => Math.abs(m.dx) > 12), 'and its width');
// The scatter grows outward, so the pile fills rather than ringing.
const far = Math.max(...pile.map((m) => Math.hypot(m.dx, m.dy)));
assert.ok(far > 20 && far < 190, `the pile should spread, not fly apart — got ${far}`);
// Stable: same marks in, same pile out, so a reload never reshuffles the page.
assert.deepEqual(
	placeCluster(march4.marks).map((m) => [m.dx, m.dy]),
	pile.map((m) => [m.dx, m.dy]),
);
// Degenerate days don't throw.
assert.deepEqual(placeCluster([]), []);
assert.equal(placeCluster([pile[0]])[0].dx, 0);

console.log('journal-month: ok');
