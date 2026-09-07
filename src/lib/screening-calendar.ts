// Shape of the Screening Room calendar: one continuous Sunday-first run of
// weeks, paginated by week so a page boundary never falls inside one. Months
// aren't separate grids any more — a barrier row is emitted in front of the
// week that carries a 1st, and that's the only thing marking the seam.
import type { QueueEntry } from './screening-queue';

export interface DayCell {
	date: string; // "YYYY-MM-DD"
	day: number;
	/** False for the few days of the neighbouring month a straddling week picks up. */
	inMonth: boolean;
	isToday: boolean;
	films: QueueEntry[];
}

export type CalendarRow =
	| { kind: 'barrier'; month: string; label: string }
	| { kind: 'week'; key: string; days: DayCell[] };

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

/** The Sunday on or before the 1st of `month` ("YYYY-MM") — where a run starts. */
export function firstSunday(month: string): string {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(y, m - 1, 1);
	d.setDate(1 - d.getDay());
	return dayKey(d);
}

/** `weeks` weeks on from a Sunday — the cursor the next page starts at. */
export function addWeeks(sunday: string, weeks: number): string {
	const d = parseDay(sunday);
	d.setDate(d.getDate() + weeks * 7);
	return dayKey(d);
}

/**
 * Build the rows for one page of the run: `weeks` weeks from `startSunday`,
 * with a barrier in front of every week that contains a 1st.
 *
 * Which month a straddling week "is" — and so which of its days get dimmed —
 * is decided per week, with no state carried across pages: a week holding a 1st
 * belongs to the new month, any other week to the month of its Sunday.
 */
export function buildRows(opts: {
	startSunday: string;
	weeks: number;
	queue: QueueEntry[];
	today: string;
}): CalendarRow[] {
	const byDay = new Map<string, QueueEntry[]>();
	for (const e of opts.queue) {
		const list = byDay.get(e.scheduled_date);
		if (list) list.push(e);
		else byDay.set(e.scheduled_date, [e]);
	}

	const rows: CalendarRow[] = [];
	const cursor = parseDay(opts.startSunday);
	for (let w = 0; w < opts.weeks; w++) {
		const dates: Date[] = [];
		for (let i = 0; i < 7; i++) {
			const d = new Date(cursor);
			d.setDate(cursor.getDate() + i);
			dates.push(d);
		}
		const opener = dates.find((d) => d.getDate() === 1);
		const owner = opener ?? dates[0]; // the month this week is filed under
		if (opener) {
			rows.push({
				kind: 'barrier',
				month: `${opener.getFullYear()}-${pad(opener.getMonth() + 1)}`,
				label: opener.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
			});
		}
		rows.push({
			kind: 'week',
			key: dayKey(dates[0]),
			days: dates.map((d) => {
				const date = dayKey(d);
				return {
					date,
					day: d.getDate(),
					inMonth: d.getMonth() === owner.getMonth(),
					isToday: date === opts.today,
					films: byDay.get(date) ?? [],
				};
			}),
		});
		cursor.setDate(cursor.getDate() + 7);
	}
	return rows;
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
