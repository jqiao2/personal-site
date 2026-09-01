// The combined month card's one piece of real arithmetic: the size weights.
//
// What is worth failing over is the CALIBRATION, not the drawing — that marks
// stay in the right order and the right ratio as the constants get tuned, that
// a snack is smaller than a meal, that boosted reading lands where it should,
// and that a day's cluster is built biggest-first from every track at once.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/journal-month.test.mjs
import assert from 'node:assert/strict';
import { weekRows as weekRowsOf } from '../src/lib/share-card.ts';
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
	CELL_MAX_H,
	MAX_COVER,
	MIN_INSIDE,
	AREA_BUDGET,
	cellBox,
	cellScale,
	markSize,
	placeCluster,
	toMark,
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
//     pile and the rest scatter around it in two dimensions — the thing a
//     wrapping flex line structurally cannot do.
const CELL = cellBox(6, 1350);
const pile = placeCluster(march4.marks, CELL);
assert.equal(pile.length, march4.marks.length);
// THE PILE IS CENTRED, NOT THE ANCHOR. The biggest print used to be pinned to
// the middle of every day, which put the day's main event dead centre and hung
// the rest of the pile off one corner of the square. Now the whole pile is
// shifted so its bounding box is centred, so the anchor is free to sit
// wherever the scatter put it.
const boundsOf = (marks) => ({
	x: [
		Math.min(...marks.map((m) => m.dx - m.box.w / 2)),
		Math.max(...marks.map((m) => m.dx + m.box.w / 2)),
	],
	y: [
		Math.min(...marks.map((m) => m.dy - m.box.h / 2)),
		Math.max(...marks.map((m) => m.dy + m.box.h / 2)),
	],
});
// Only as far as it can go, mind: the shift is clamped so that recentring
// never pushes a print off its own day (see MIN_INSIDE below), so on a tight
// pile the middle lands near the day's, not exactly on it.
const bounds = boundsOf(pile);
assert.ok(Math.abs(bounds.x[0] + bounds.x[1]) / 2 < CELL.w * 0.15, 'the pile is centred across');
assert.ok(Math.abs(bounds.y[0] + bounds.y[1]) / 2 < CELL.h * 0.15, 'and down');
// A day with one thing in it still has that thing in the middle: its own box
// is the pile's box.
const alone = placeCluster([{ ...pile[0], dx: 0, dy: 0 }], CELL)[0];
assert.deepEqual([alone.dx, alone.dy], [0, 0], 'one print sits in the middle of its day');
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
	placeCluster(march4.marks, CELL).map((m) => [m.dx, m.dy]),
	pile.map((m) => [m.dx, m.dy]),
);
// NOTHING GETS BURIED. This is the property that matters and the one that has
// regressed twice — first from spacing off the day's mean print size, then from
// modelling tall posters as circles. Measured the way you'd actually judge it:
// how much of each print its neighbours hide, using the real rectangles.
const area = (m) => m.box.w * m.box.h;
const hiddenOf = (pile, i) =>
	pile.reduce((total, other, j) => {
		if (j <= i) return total; // only prints painted on top of this one
		const x =
			Math.min(pile[i].dx + pile[i].box.w / 2, other.dx + other.box.w / 2) -
			Math.max(pile[i].dx - pile[i].box.w / 2, other.dx - other.box.w / 2);
		const y =
			Math.min(pile[i].dy + pile[i].box.h / 2, other.dy + other.box.h / 2) -
			Math.max(pile[i].dy - pile[i].box.h / 2, other.dy - other.box.h / 2);
		return total + (x > 0 && y > 0 ? x * y : 0);
	}, 0);
for (let i = 0; i < pile.length; i++) {
	const frac = hiddenOf(pile, i) / area(pile[i]);
	assert.ok(
		frac <= MAX_COVER + 0.01,
		`"${pile[i].title}" is ${(frac * 100).toFixed(0)}% buried — must stay under ${MAX_COVER * 100}%`,
	);
}

// A small print dropped next to a big one clears the BIG one's real box, not
// the average of the two and not a circle standing in for it — between them,
// the two bugs that buried Magnolia behind a snapshot.
const lopsided = placeCluster([
	{ ...pile[0], key: 'big', box: { w: 72, h: 108 }, dx: 0, dy: 0 },
	{ ...pile[0], key: 'small', box: { w: 30, h: 30 }, dx: 0, dy: 0 },
], CELL);
assert.ok(hiddenOf(lopsided, 0) / area(lopsided[0]) <= MAX_COVER + 0.01);
// The coverage budget alone would have allowed this one: a 30px print laid dead
// centre on a 72x108 poster hides only 11% of it. Its centre still has to clear
// the poster's box, or it reads as stuck to it rather than beside it.
// Measured against the big print, not the day: the pile gets recentred
// afterwards, so the anchor is no longer guaranteed to be at 0,0.
assert.ok(
	Math.abs(lopsided[1].dx - lopsided[0].dx) > 36 ||
		Math.abs(lopsided[1].dy - lopsided[0].dy) > 54,
	'a small print must not sit dead centre on a big one',
);

// Two tall posters, the 16th's actual case: circles said they cleared, the
// rectangles they really are did not.
//
// COVERAGE IS BEST-EFFORT NOW, NOT A GUARANTEE. Three near-full-size posters
// cannot all keep half their body on one Feed cell AND all stay 70% visible —
// the room isn't there. Containment wins that argument (a print you have to
// trace back to its own date is worse than a partly covered one), so what the
// search promises is the least burial available inside the day, and the number
// to fail over is the one that stops a print being recognisable.
const CROWDED_COVER = 0.4;
const posters = placeCluster([
	{ ...pile[0], key: 'a', box: { w: 72, h: 108 }, dx: 0, dy: 0 },
	{ ...pile[0], key: 'b', box: { w: 69, h: 103 }, dx: 0, dy: 0 },
	{ ...pile[0], key: 'c', box: { w: 60, h: 89 }, dx: 0, dy: 0 },
], CELL);
for (let i = 0; i < posters.length; i++) {
	const frac = hiddenOf(posters, i) / area(posters[i]);
	assert.ok(frac <= CROWDED_COVER, `poster ${i} is ${(frac * 100).toFixed(0)}% buried`);
}

// Degenerate days don't throw.
assert.deepEqual(placeCluster([], CELL), []);

// A PRINT STAYS ON ITS OWN DAY. It may spill — that is the look — but never so
// far that most of it belongs to the following week, which is what the old
// unbounded outward walk did to a crowded day: the 16th's last poster ended up
// a full cell below its own date, unreadable as the 16th's.
const insideOf = (mark, cell) => {
	const x = Math.max(0, Math.min(mark.box.w, cell.w, (mark.box.w + cell.w) / 2 - Math.abs(mark.dx)));
	const y = Math.max(0, Math.min(mark.box.h, cell.h, (mark.box.h + cell.h) / 2 - Math.abs(mark.dy)));
	return (x * y) / (mark.box.w * mark.box.h);
};
for (const mark of pile) {
	assert.ok(
		insideOf(mark, CELL) >= MIN_INSIDE - 0.01,
		`"${mark.title}" is only ${(insideOf(mark, CELL) * 100).toFixed(0)}% on its own day`,
	);
}

// The crowded case, which is the one that breaks: nine things on one Sunday.
// Every print still keeps its half on the day, and the day's total print area
// is held to AREA_BUDGET — the shrink that makes containment possible at all.
const busy = buildCells(
	'2026-08',
	Array.from({ length: 9 }, (_, i) => ({
		...march4.marks[i % march4.marks.length],
		key: `busy-${i}`,
		day: '2026-08-16',
		minutes: 240 - i * 25,
	})),
	CELL,
);
const sixteenth = busy.find((c) => c.date === 16);
assert.equal(sixteenth.marks.length, 9);
for (const mark of sixteenth.marks) {
	assert.ok(
		insideOf(mark, CELL) >= MIN_INSIDE - 0.01,
		`a print on a nine-print day is only ${(insideOf(mark, CELL) * 100).toFixed(0)}% on its day`,
	);
}
// And no print on it disappears under the others, which is the failure the
// px²-denominated cost used to produce: the cheapest place to dump overlap was
// always on top of the day's biggest print, and it came out 89% buried.
for (let i = 0; i < sixteenth.marks.length; i++) {
	const frac = hiddenOf(sixteenth.marks, i) / area(sixteenth.marks[i]);
	assert.ok(frac <= CROWDED_COVER, `a print on a nine-print day is ${(frac * 100).toFixed(0)}% buried`);
}
const spent = sixteenth.marks.reduce((total, m) => total + m.box.w * m.box.h, 0);
assert.ok(
	spent <= AREA_BUDGET * CELL.w * CELL.h * 1.02,
	`a crowded day spends ${(spent / (CELL.w * CELL.h)).toFixed(2)} cells of print, over the ${AREA_BUDGET} budget`,
);
// Shrinking is UNIFORM, so within the day the areas still stand in the ratio
// of the minutes they mean.
const [biggest, next] = sixteenth.marks;
assert.ok(
	(biggest.box.w * biggest.box.h) / (next.box.w * next.box.h) > 1,
	'the longest thing on a crowded day is still the biggest print on it',
);

// 15. THE SCATTER IS A QUESTION ABOUT THE DAY'S SQUARE, and that square is a
//     different shape at every aspect: a Feed cell is ~167px tall, a Story one
//     230. Holding the pile's travel fixed is what let the Feed card bury the
//     week above it while the Story card looked right.
const feed = cellBox(weekRowsOf('2026-08'), 1350);
const story = cellBox(weekRowsOf('2026-08'), 1920);
assert.ok(story.h > feed.h, 'a taller artboard gives a day more room');
assert.equal(story.h, CELL_MAX_H, 'and the cell stops growing at the cap');
assert.equal(feed.w, story.w, 'only the height of a cell ever changes');

// Prints scale with the square, so the same pile takes up the same PROPORTION
// of its day whatever the card is cut to.
assert.ok(cellScale(story) > cellScale(feed));
assert.equal(cellScale(story), 1, 'the roomiest cell is the reference, so it never scales');
assert.ok(cellScale(feed) >= 0.7 && cellScale(feed) < 1, 'and a shorter cell only ever shrinks');

// The spill is measured against the cell it spills out of, and stays comparable.
function spillOf(cell) {
	const marks = placeCluster(
		march4.marks.map((m) => toMark(m, cellScale(cell))),
		cell,
	);
	const ys = marks.flatMap((m) => [m.dy - m.box.h / 2, m.dy + m.box.h / 2]);
	return (Math.max(...ys.map(Math.abs)) - cell.h / 2) / cell.h;
}
const feedSpill = spillOf(feed);
const storySpill = spillOf(story);
assert.ok(
	Math.abs(feedSpill - storySpill) < 0.2,
	`the pile should spill a similar share of its day at either aspect — feed ${(feedSpill * 100).toFixed(0)}%, story ${(storySpill * 100).toFixed(0)}%`,
);

console.log('journal-month: ok');
