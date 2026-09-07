// The runnable check on the Screening Room's continuous calendar: that pages
// tile without a gap or a repeated week, that a barrier lands in front of every
// month, and that a straddling week dims the right days. Imports
// src/lib/screening-calendar.ts, which touches no database — runs with no .env
// and no network.
//
//   node --import ./scripts/ts-hook.mjs scripts/screening-calendar.test.mjs
import assert from 'node:assert/strict';
import {
	addWeeks,
	buildRows,
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

// --- Rows -------------------------------------------------------------------
const weeks = (rows) => rows.filter((r) => r.kind === 'week');
const barriers = (rows) => rows.filter((r) => r.kind === 'barrier');

const page1 = buildRows({ startSunday: '2026-08-30', weeks: 12, queue: [], today: '2026-09-07' });
assert.equal(weeks(page1).length, 12);
// Sep, Oct and Nov each open inside the 12 weeks from 2026-08-30.
assert.deepEqual(
	barriers(page1).map((b) => b.month),
	['2026-09', '2026-10', '2026-11'],
);
// The barrier comes immediately before the week carrying the 1st.
const sepAt = page1.findIndex((r) => r.kind === 'barrier' && r.month === '2026-09');
assert.equal(page1[sepAt + 1].days[0].date, '2026-08-30');

// A week is seven consecutive days, Sunday first.
for (const w of weeks(page1)) {
	assert.equal(w.days.length, 7);
	assert.equal(w.key, w.days[0].date);
}

// The straddling first week: Aug 30–31 belong to the previous month, so they're
// dimmed; Sep 1 onward are not.
const straddle = weeks(page1)[0];
assert.deepEqual(
	straddle.days.map((d) => d.inMonth),
	[false, false, true, true, true, true, true],
);
// A week wholly inside one month is never dimmed.
assert.ok(weeks(page1)[1].days.every((d) => d.inMonth));

// --- Pagination tiles exactly -----------------------------------------------
// The next page starts where this one stopped: no gap, no repeated week.
const page2 = buildRows({
	startSunday: addWeeks('2026-08-30', 12),
	weeks: 12,
	queue: [],
	today: '2026-09-07',
});
const keys = [...weeks(page1), ...weeks(page2)].map((w) => w.key);
assert.equal(new Set(keys).size, keys.length, 'a week was rendered twice');
assert.equal(weeks(page2)[0].key, addWeeks(weeks(page1)[11].key, 1));
// Every month still gets exactly one barrier across the seam.
const months = [...barriers(page1), ...barriers(page2)].map((b) => b.month);
assert.equal(new Set(months).size, months.length, 'a month got two barriers');

// --- Films land on their day ------------------------------------------------
const withFilms = buildRows({
	startSunday: '2026-08-30',
	weeks: 2,
	queue: [q('2026-09-07', 11), q('2026-09-07', 22), q('2026-09-09', 33)],
	today: '2026-09-07',
});
const day = (date) =>
	weeks(withFilms)
		.flatMap((w) => w.days)
		.find((d) => d.date === date);
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
