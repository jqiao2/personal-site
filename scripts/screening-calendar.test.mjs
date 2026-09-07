// The runnable check on the Screening Room's continuous calendar: that pages
// tile without a gap or a repeated week, and that the month seam is drawn on
// the right edges — the step around the 1st that stands in for a month header.
// Imports src/lib/screening-calendar.ts, which touches no database — runs with
// no .env and no network.
//
//   node --import ./scripts/ts-hook.mjs scripts/screening-calendar.test.mjs
import assert from 'node:assert/strict';
import {
	addWeeks,
	buildWeeks,
	firstSunday,
	runStartMonth,
} from '../src/lib/screening-calendar.ts';

const q = (date, tmdb_id = 1) => ({
	tmdb_id,
	title: 'Film',
	release_year: null,
	poster_path: null,
	scheduled_date: date,
	venue: null,
	source: 'manual',
});

// --- Where a run opens ------------------------------------------------------
// 2026-09-01 is a Tuesday, so its week opens on Sunday 2026-08-30.
assert.equal(firstSunday('2026-09'), '2026-08-30');
// 2026-11-01 is itself a Sunday.
assert.equal(firstSunday('2026-11'), '2026-11-01');
assert.equal(addWeeks('2026-08-30', 12), '2026-11-22');
assert.equal(addWeeks('2026-01-03', -1), '2025-12-27');

// --- Weeks ------------------------------------------------------------------
const page1 = buildWeeks({ startSunday: '2026-08-30', weeks: 12, queue: [], today: '2026-09-07' });
assert.equal(page1.length, 12);
// A week is seven consecutive days, Sunday first, keyed by its Sunday.
for (const w of page1) {
	assert.equal(w.days.length, 7);
	assert.equal(w.key, w.days[0].date);
}

// --- The seam steps around the 1st ------------------------------------------
// Sep 1 2026 is a Tuesday: Aug 30–31 close out August, Sep 1–5 open September.
// So the line runs under Sun–Mon, down the left of Tue, and over Tue–Sat.
const cutWeek = page1[0];
assert.deepEqual(cutWeek.days.map((d) => d.edgeBottom), [true, true, false, false, false, false, false]);
assert.deepEqual(cutWeek.days.map((d) => d.edgeTop), [false, false, true, true, true, true, true]);
assert.deepEqual(cutWeek.days.map((d) => d.edgeLeft), [false, false, true, false, false, false, false]);
// Only the 1st is labelled, and it says which month it opens.
assert.deepEqual(cutWeek.days.map((d) => d.monthLabel), [null, null, 'Sep', null, null, null, null]);

// A week wholly inside a month carries no seam at all.
const plainWeek = page1[1];
assert.ok(plainWeek.days.every((d) => !d.edgeTop && !d.edgeBottom && !d.edgeLeft));
assert.ok(plainWeek.days.every((d) => d.monthLabel === null));

// When the 1st is a Sunday the step flattens: one line across the whole top,
// nothing hanging below, and no vertical segment.
const nov = buildWeeks({ startSunday: '2026-11-01', weeks: 1, queue: [], today: '2026-09-07' });
assert.ok(nov[0].days.every((d) => d.edgeTop));
assert.ok(nov[0].days.every((d) => !d.edgeBottom && !d.edgeLeft));
assert.equal(nov[0].days[0].monthLabel, 'Nov');

// Every month in the page gets exactly one seam, and the run has no stray ones.
const opens = page1.flatMap((w) => w.days).filter((d) => d.monthLabel !== null);
assert.deepEqual(opens.map((d) => d.date), ['2026-09-01', '2026-10-01', '2026-11-01']);

// --- Pagination tiles exactly -----------------------------------------------
// The next page starts where this one stopped: no gap, no repeated week.
const page2 = buildWeeks({
	startSunday: addWeeks('2026-08-30', 12),
	weeks: 12,
	queue: [],
	today: '2026-09-07',
});
const keys = [...page1, ...page2].map((w) => w.key);
assert.equal(new Set(keys).size, keys.length, 'a week was rendered twice');
assert.equal(page2[0].key, addWeeks(page1[11].key, 1));
// And no month is opened twice across the seam between pages.
const months = [...page1, ...page2]
	.flatMap((w) => w.days)
	.filter((d) => d.monthLabel !== null)
	.map((d) => d.date.slice(0, 7));
assert.equal(new Set(months).size, months.length, 'a month was opened twice');

// --- Films land on their day ------------------------------------------------
const withFilms = buildWeeks({
	startSunday: '2026-08-30',
	weeks: 2,
	queue: [q('2026-09-07', 11), q('2026-09-07', 22), q('2026-09-09', 33)],
	today: '2026-09-07',
});
const day = (date) =>
	withFilms.flatMap((w) => w.days).find((d) => d.date === date);
assert.deepEqual(day('2026-09-07').films.map((f) => f.tmdb_id), [11, 22]);
assert.equal(day('2026-09-07').isToday, true);
assert.deepEqual(day('2026-09-09').films.map((f) => f.tmdb_id), [33]);
assert.deepEqual(day('2026-09-08').films, []);
assert.equal(day('2026-09-08').isToday, false);

// --- Scrollback is bounded --------------------------------------------------
// Nothing queued, or only queued ahead → the run opens on the current month.
assert.equal(runStartMonth([], '2026-09-07'), '2026-09');
assert.equal(runStartMonth([q('2026-12-01')], '2026-09-07'), '2026-09');
// Something queued a little earlier → open there instead.
assert.equal(runStartMonth([q('2026-07-14')], '2026-09-07'), '2026-07');
// Something queued years back doesn't drag the run all the way there.
assert.equal(runStartMonth([q('2019-01-14')], '2026-09-07'), '2026-06');

console.log('screening-calendar: ok');
