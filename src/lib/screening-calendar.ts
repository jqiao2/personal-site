// Shape of the Screening Room calendar: one continuous Monday-first run of
// weeks, paginated by week so a page boundary never falls inside one. Months
// aren't separate grids and don't get a row of their own — the seam is drawn on
// the grid lines themselves, which step around the 1st into an S.
import type { QueueEntry } from './screening-queue';

export interface DayCell {
	date: string; // "YYYY-MM-DD"
	day: number;
	/** "Oct" on the 1st, null on every other day — the only month label there is. */
	monthLabel: string | null;
	isToday: boolean;
	films: QueueEntry[];
	/** The month seam, as the three edges it runs along in this week. */
	edgeTop: boolean;
	edgeBottom: boolean;
	edgeLeft: boolean;
}

export interface CalendarWeek {
	key: string; // the week's Sunday
	days: DayCell[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a local Date. */
export function dayKey(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as a local date (`new Date(str)` would read it as UTC). */
export function parseDay(s: string): Date {
	const [y, m, d] = s.split('-').map(Number);
	return new Date(y, m - 1, d);
}

/** The Monday on or before the 1st of `month` ("YYYY-MM") — where a run starts. */
export function firstMonday(month: string): string {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(y, m - 1, 1);
	d.setDate(1 - ((d.getDay() + 6) % 7)); // Mon-first column of the 1st
	return dayKey(d);
}

/** `weeks` weeks on from a Monday — the cursor the next page starts at. */
export function addWeeks(monday: string, weeks: number): string {
	const d = parseDay(monday);
	d.setDate(d.getDate() + weeks * 7);
	return dayKey(d);
}

/**
 * Build one page of the run: `weeks` weeks from `startMonday`.
 *
 * A month seam is a cut in the linear run of days, so on a 7-column grid it
 * comes out as a step: along the top of the 1st and everything after it in that
 * week, down the left of the 1st, and along the bottom of the days before it.
 * When the 1st is itself a Monday the step flattens to a single line. Each week
 * decides its own edges, so nothing has to be carried across a page boundary.
 */
export function buildWeeks(opts: {
	startMonday: string;
	weeks: number;
	queue: QueueEntry[];
	today: string;
}): CalendarWeek[] {
	const byDay = new Map<string, QueueEntry[]>();
	for (const e of opts.queue) {
		const list = byDay.get(e.scheduled_date);
		if (list) list.push(e);
		else byDay.set(e.scheduled_date, [e]);
	}

	const out: CalendarWeek[] = [];
	const cursor = parseDay(opts.startMonday);
	for (let w = 0; w < opts.weeks; w++) {
		const dates: Date[] = [];
		for (let i = 0; i < 7; i++) {
			const d = new Date(cursor);
			d.setDate(cursor.getDate() + i);
			dates.push(d);
		}
		// Where the seam cuts this week, or -1 for a week wholly inside a month.
		const cut = dates.findIndex((d) => d.getDate() === 1);

		out.push({
			key: dayKey(dates[0]),
			days: dates.map((d, i) => {
				const date = dayKey(d);
				return {
					date,
					day: d.getDate(),
					monthLabel: d.getDate() === 1 ? d.toLocaleDateString('en-US', { month: 'short' }) : null,
					isToday: date === opts.today,
					films: byDay.get(date) ?? [],
					edgeTop: cut !== -1 && i >= cut,
					edgeBottom: cut !== -1 && i < cut,
					edgeLeft: i === cut && cut > 0,
				};
			}),
		});
		cursor.setDate(cursor.getDate() + 7);
	}
	return out;
}

/**
 * Where the run opens: the current month, pulled back to the earliest month
 * anything is queued in, but never more than three months of empty scrollback.
 */
export function runStartMonth(queue: QueueEntry[], today: string): string {
	const current = today.slice(0, 7);
	const [cy, cm] = current.split('-').map(Number);
	const floor = dayKey(new Date(cy, cm - 4, 1)).slice(0, 7); // three months back
	const earliest = queue.reduce(
		(min, e) => (e.scheduled_date < min ? e.scheduled_date : min),
		today,
	).slice(0, 7);
	return earliest < floor ? floor : earliest;
}
