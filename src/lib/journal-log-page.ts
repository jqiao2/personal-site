// The paging arithmetic behind /log, the every-entry version of the home feed.
// Pure on purpose — no query layer — so scripts/journal-log.test.mjs can load it.

import type { Track } from './journal-month';

/** Rows per page. The same 15 the home feed shows, so the home feed IS page 1
 *  and its "See more" link lands on page 2 with nothing repeated. */
export const PAGE_SIZE = 15;

/** The least of a feed row that decides where it sorts: enough to order every
 *  entry ever logged without fetching a poster or a route for any of them. */
export interface LogEntry {
	track: Track;
	key: string;
	day: string;
	logged: string;
}

/** Reverse-chronological: newest day first, and within a day the last thing
 *  logged on top. The home feed and /log share this, so a row sits in the same
 *  place in both. */
export function compareEntries(a: LogEntry, b: LogEntry): number {
	return (
		b.day.localeCompare(a.day) ||
		b.logged.localeCompare(a.logged) ||
		a.track.localeCompare(b.track) ||
		a.key.localeCompare(b.key)
	);
}

/** A track-qualified key: a film and a meal can share an id. */
export function entryId(e: Pick<LogEntry, 'track' | 'key'>): string {
	return `${e.track}:${e.key}`;
}

export function pageCount(total: number, size = PAGE_SIZE): number {
	return Math.max(1, Math.ceil(total / size));
}

/** The 1-based page's slice of an already sorted list. */
export function pageSlice<T>(sorted: T[], page: number, size = PAGE_SIZE): T[] {
	return sorted.slice((page - 1) * size, page * size);
}

/**
 * Which page numbers the pager prints: the first, the last, and a window of
 * `reach` either side of the current one, with `null` wherever a run is
 * skipped. A gap of exactly one page prints the page instead — an ellipsis
 * standing in for a single number saves nothing.
 */
export function pagerNumbers(page: number, count: number, reach = 2): (number | null)[] {
	const keep = new Set<number>([1, count]);

	for (let p = page - reach; p <= page + reach; p++) {
		if (p >= 1 && p <= count) keep.add(p);
	}

	const sorted = [...keep].sort((a, b) => a - b);
	const out: (number | null)[] = [];

	for (const p of sorted) {
		const prev = out.length ? sorted[sorted.indexOf(p) - 1] : undefined;

		if (prev !== undefined && p - prev === 2) out.push(prev + 1);
		else if (prev !== undefined && p - prev > 2) out.push(null);
		out.push(p);
	}

	return out;
}
