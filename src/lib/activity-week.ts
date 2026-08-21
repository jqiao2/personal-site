// The landing page's week grid — pure date/grouping logic, no I/O. This file
// turns `listActivityDays()`'s flat, sparse rows (one row per day that HAD an
// activity) into a dense, reverse-chronological grid of Monday–Sunday weeks,
// every day present whether or not anything happened on it.
//
// MONDAY, NOT SUNDAY. ACTIVITIES.md §1 calls for a Mon–Sun week explicitly —
// the ISO convention, and the one a training calendar actually uses (a "week"
// of training runs Monday through the weekend's long ride). JS's own
// `Date#getDay()` returns 0 for Sunday, so the naive `date.getDate() -
// date.getDay()` gives you the *Sunday* that starts the week, off by a day
// every time except when the date already falls on a Sunday. `weekStart`
// below re-indexes explicitly (`(day + 6) % 7` turns Mon=1..Sat=6,Sun=0 into
// Mon=0..Sun=6) so the bug has nowhere to hide.
//
// DATES ARE STRINGS, NEVER PARSED AS UTC. `local_date` is a plain
// 'YYYY-MM-DD' — the calendar day the activity happened on, already resolved
// against the device's own UTC offset at ingest time (see the schema comment
// on `activities.local_date`). `new Date('2026-08-11')` parses that as UTC
// midnight, which prints as Aug 10 in any zone west of Greenwich — exactly
// the bug src/lib/format.ts and src/lib/day.ts both route around by building
// `Date`s from separate Y/M/D numbers (`new Date(y, m - 1, d)`, which the
// runtime treats as *local* midnight) instead of parsing a string. Every
// function here does the same, and because the strings are all
// zero-padded 'YYYY-MM-DD', they also sort and compare correctly as plain
// strings — `isFuture` below is a string comparison, not a Date one.
//
// WHY EVERY WEEK HAS ALL 7 DAYS, EVEN WHEN NOTHING HAPPENED ON MOST OF THEM.
// `listActivityDays()` only returns rows for days with at least one activity
// — a rest day has no row at all. If this file grouped *those* rows into
// weeks, a week with one Tuesday ride would render as a single cell, and a
// week with zero activities would vanish entirely rather than showing as a
// blank week. Neither reads as a calendar. So `groupIntoWeeks` doesn't derive
// its weeks from the data — it derives them from `today`, walking backward a
// fixed number of *calendar* weeks, and looks up each of the resulting 49–112
// dates in the sparse data. A day with no row becomes a real, zeroed cell
// (§1: "a quiet empty cell ... not a gap").
//
// WHY THE ANCHOR IS "TODAY" AND NOT "THE MOST RECENT ACTIVITY". Anchoring on
// the latest activity would make the grid's first row silently jump backward
// whenever the athlete takes a few days off — the exact moment a training
// calendar most wants to keep showing you the empty days. Anchoring on today
// means this week's not-yet-happened days render too (`isFuture`), which is
// also the honest reading of a page titled with today's date on it.
//
// WHY TOTALS ARE SUMMED FROM `activity_days`' OWN COLUMNS, NOT RECOMPUTED
// FROM THE JOINED ACTIVITY LIST. `activity_days` already excludes multisport
// child legs from its sums (the parent row carries the whole day) — see the
// view's comment in 0034_activity_log.sql. Re-summing distance/elevation/time
// from `DayCell.activities` here would have to re-derive that same exclusion
// by hand and risk drifting from the view's definition of "the day's
// totals". Summing the columns the view already computed keeps the one
// definition in one place.
import { siteDay, siteYear } from './day';
import type { ActivityDayWithActivities, ActivityListRow } from './activities';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → a local (not UTC) `Date` at that day's midnight. */
function parseLocal(date: string): Date {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(y, (m || 1) - 1, d || 1);
}

/** A local `Date` → 'YYYY-MM-DD'. */
function toLocal(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `date` shifted by `n` days (negative to go backward). Crosses month/year
 * boundaries correctly because `Date#setDate` normalises the whole object. */
export function addDays(date: string, n: number): string {
	const d = parseLocal(date);
	d.setDate(d.getDate() + n);
	return toLocal(d);
}

/**
 * The Monday, as 'YYYY-MM-DD', of the ISO week `localDate` falls in. See the
 * header comment for why this isn't `date.getDate() - date.getDay()`.
 */
export function weekStart(localDate: string): string {
	const d = parseLocal(localDate);
	const mondayOffset = (d.getDay() + 6) % 7; // Mon→0, Tue→1, …, Sun→6
	d.setDate(d.getDate() - mondayOffset);
	return toLocal(d);
}

/**
 * "Aug 11 – 17" within one month, "Jul 28 – Aug 3" across two, with the year
 * appended ("Jul 28 – Aug 3, 2025") whenever the week isn't in the current
 * (site) calendar year — a week the reader can't otherwise assume is "this
 * year" needs the year spelled out, the way a dateline would.
 */
export function weekLabel(monday: string, sunday: string): string {
	const [my, mm, md] = monday.split('-').map(Number);
	const [sy, sm, sd] = sunday.split('-').map(Number);
	const start = `${MONTH_ABBR[mm - 1]} ${md}`;
	const end = mm === sm ? `${sd}` : `${MONTH_ABBR[sm - 1]} ${sd}`;
	const base = `${start} – ${end}`;
	return my === siteYear() && sy === siteYear() ? base : `${base}, ${sy}`;
}

export interface DayCell {
	date: string;
	isToday: boolean;
	isFuture: boolean;
	/** That day's activities, oldest-first — straight from `listActivityDays`.
	 * [] for a rest day, never omitted, so a cell always has something to map over. */
	activities: ActivityListRow[];
	activityCount: number;
	distanceM: number;
	elevationGainM: number;
	movingSeconds: number;
	exertion: number;
}

export interface WeekTotals {
	activityCount: number;
	distanceM: number;
	elevationGainM: number;
	movingSeconds: number;
	exertion: number;
}

export interface ActivityWeek {
	/** Monday, 'YYYY-MM-DD'. */
	mondayDate: string;
	/** Sunday, 'YYYY-MM-DD'. */
	endDate: string;
	label: string;
	/** Always exactly 7 — Monday first, Sunday last. */
	days: DayCell[];
	totals: WeekTotals;
}

const EMPTY_TOTALS: WeekTotals = {
	activityCount: 0,
	distanceM: 0,
	elevationGainM: 0,
	movingSeconds: 0,
	exertion: 0,
};

/** Sums a set of day cells' rollups into one week (or any other) total. */
export function sumTotals(cells: readonly Pick<DayCell, keyof WeekTotals>[]): WeekTotals {
	return cells.reduce(
		(acc, c) => ({
			activityCount: acc.activityCount + c.activityCount,
			distanceM: acc.distanceM + c.distanceM,
			elevationGainM: acc.elevationGainM + c.elevationGainM,
			movingSeconds: acc.movingSeconds + c.movingSeconds,
			exertion: acc.exertion + c.exertion,
		}),
		{ ...EMPTY_TOTALS },
	);
}

/**
 * Groups `listActivityDays()`'s rows into complete Mon–Sun weeks, newest
 * first, walking back `opts.weeks` weeks (default 12) from the week
 * containing `opts.today` (default the site's own today — see src/lib/day.ts).
 * Every day in every week gets a cell, populated from `days` where a row
 * exists and zeroed where it doesn't (see the header comment for why).
 *
 * `days` need not (and for a distant week, won't) cover the whole range —
 * a date with no matching row simply comes back as an empty cell. Callers
 * decide how far back to fetch; this function decides how the result is cut
 * into weeks.
 */
export function groupIntoWeeks(
	days: readonly ActivityDayWithActivities[],
	opts: { weeks?: number; today?: string } = {},
): ActivityWeek[] {
	const weekCount = opts.weeks ?? 12;
	const today = opts.today ?? siteDay();
	const currentMonday = weekStart(today);
	const byDate = new Map(days.map((d) => [d.local_date, d]));

	const weeks: ActivityWeek[] = [];
	for (let w = 0; w < weekCount; w++) {
		const monday = addDays(currentMonday, -7 * w);
		const cells: DayCell[] = [];
		for (let i = 0; i < 7; i++) {
			const date = addDays(monday, i);
			const row = byDate.get(date);
			cells.push({
				date,
				isToday: date === today,
				isFuture: date > today,
				activities: row?.activities ?? [],
				activityCount: row?.activity_count ?? 0,
				distanceM: row?.total_distance_m ?? 0,
				elevationGainM: row?.total_elevation_gain_m ?? 0,
				movingSeconds: row?.total_moving_seconds ?? 0,
				exertion: row?.total_exertion ?? 0,
			});
		}
		const sunday = cells[6].date;
		weeks.push({
			mondayDate: monday,
			endDate: sunday,
			label: weekLabel(monday, sunday),
			days: cells,
			totals: sumTotals(cells),
		});
	}
	return weeks;
}
