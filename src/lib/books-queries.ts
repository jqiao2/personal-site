// Read side of the book log: everything the /books page needs.
//
// All of it goes through supabaseAdmin. The reading tables have RLS on with no
// policies (migration 0020), so the anon client sees nothing — session rows are
// a precise log of when the owner is awake at night and never leave the server.
// What ships to the browser is what these helpers return: aggregates, and books
// that have opted in via `is_public`.
//
// Every day-level number below has a minimum applied under it: a book counts
// towards a day only if more than `reading_day_min_pages()` pages of it were
// turned that day, so opening something to check a reference no longer lights a
// heatmap square or holds a streak together. It is enforced once, in the views
// (migration 0028), and nothing here re-checks it.
//
// Write side lives in src/lib/books-sync.ts.
import { supabaseAdmin } from './supabase';
import { monthOf, shiftMonth } from './share-card';
import type { MonthBook, ReadingDay } from './reading-month-view';

export interface HeatmapDay {
	day: string; // YYYY-MM-DD, local (America/New_York — see migration 0020)
	pages_read: number;
	seconds_read: number;
	books_touched: number;
}

export interface BookProgress {
	id: number;
	md5: string;
	/** Corrected title where one exists, KOReader's otherwise — resolved in the view. */
	title: string;
	authors: string | null;
	/**
	 * What KOReader calls the file, uncorrected. Not for display; it's what you
	 * need when a book stops matching and you're working out why.
	 */
	source_title: string;
	series: string | null;
	total_pages: number | null;
	cover_url: string | null;
	is_public: boolean;
	finished_at: string | null;
	furthest_page: number;
	distinct_pages_read: number;
	seconds_read: number;
	first_read_at: string;
	last_read_at: string;
	/** Days that cleared the minimum. The page and time totals above do not. */
	days_read: number;
	/** 0–1, clamped. Null when the book's page count is unknown. */
	progress: number | null;
	/** The printed edition's length, for drawing the spine. See migration 0026. */
	ol_pages: number | null;
}

/**
 * A finished book with no page turns behind it — read before the sync existed,
 * or with the tracking off. Almost none of BookProgress applies: no furthest page, no
 * time on it and no pace, and the only record of when it happened is the date
 * range on its review.
 */
export interface OfflineRead {
	id: number;
	title: string;
	authors: string | null;
	total_pages: number | null;
	is_public: boolean;
	finished_at: string;
	/** From the most recent review. Null when the read was never written up. */
	read_from: string | null;
	read_to: string | null;
	rating: number | null;
	loved: boolean;
	/** How many reviews the book has, i.e. how many times it was read. */
	reads: number;
	/** The printed edition's length, for drawing the spine. See migration 0026. */
	ol_pages: number | null;
}

/**
 * A book on the to-read pile: intended, never opened. Almost nothing is known
 * about it and that is not a defect — half the pile is typed in by hand, with a
 * title and an author and no page count to draw a spine from.
 */
export interface PileBook {
	id: number;
	md5: string | null;
	title: string;
	authors: string | null;
	subtitle: string | null;
	series: string | null;
	total_pages: number | null;
	cover_url: string | null;
	/** Open Library work key, or null for a book that was typed in. */
	ol_key: string | null;
	first_published: string | null;
	kind: string | null;
	is_public: boolean;
	added_at: string;
	/** The printed edition's length, for drawing the spine. See migration 0026. */
	ol_pages: number | null;
}

/**
 * A book being read away from any device — started by hand, no page turns.
 *
 * The complement of getCurrentlyReading, which can only see books the Kindle
 * reported. Between them the "Currently reading" section holds every book in
 * flight, measured or not.
 */
export interface ManualRead {
	id: number;
	title: string;
	authors: string | null;
	subtitle: string | null;
	total_pages: number | null;
	cover_url: string | null;
	is_public: boolean;
	added_at: string | null;
	started_at: string;
	/** The printed edition's length, for drawing the spine. See migration 0026. */
	ol_pages: number | null;
}

export interface ReadingStats {
	current_streak: number;
	longest_streak: number;
	days_read: number;
	total_pages: number;
	total_seconds: number;
	first_day: string | null;
	last_day: string | null;
}

/** How recently a book must have been touched to still count as "currently reading". */
export const CURRENTLY_READING_DAYS = 30;

/**
 * Every day from `from` to `to` inclusive, zeros included.
 *
 * The gap-filling happens in SQL (`reading_heatmap`): reading_daily has no row
 * for a day with no reading, and a heatmap that skips its blanks is a bar chart.
 *
 * A day whose only reading fell under the minimum comes back as a zero, the same
 * as a day nothing was opened at all — which is the point of having a minimum.
 */
export async function getHeatmap(from: string, to: string): Promise<HeatmapDay[]> {
	const { data, error } = await supabaseAdmin.rpc('reading_heatmap', {
		p_from: from,
		p_to: to,
	});
	if (error) throw new Error(`heatmap query failed: ${error.message}`);
	return (data ?? []) as HeatmapDay[];
}

/**
 * Everything the month card needs for one "YYYY-MM": the day rows, the books
 * behind them, and how many books were finished that month.
 *
 * Three round trips rather than an embed, because `book_days` is a GROUP BY view
 * and PostgREST can't be relied on to infer a relationship through one.
 *
 * A private book comes back with its title and cover stripped here rather than
 * in the page: the card draws it as a blank print, and what a redacted book is
 * called has no business travelling to the browser at all.
 *
 * A book that was barely opened on a day holds no cell there: `book_days` has
 * the minimum applied (migration 0028), so a day of it never reaches the card.
 * A book below the line on every day of the month is absent from it entirely.
 *
 * `markedFinished` are the books whose `finished_at` falls in the month. It is a
 * separate query because a book finished by hand can have no page turns behind
 * it at all — a paper read, or a StoryGraph import — and still belongs in the
 * month's count despite having no cell to sit in. Books finished the other way,
 * by reaching the end, are found from the day rows by the caller.
 */
export async function getReadingMonth(key: string): Promise<{
	days: ReadingDay[];
	books: MonthBook[];
	markedFinished: number[];
}> {
	const from = `${key}-01`;
	const to = `${shiftMonth(key, 1)}-01`;

	const [dayRows, marked] = await Promise.all([
		supabaseAdmin
			.from('book_days')
			.select('book_id, day, pages, seconds')
			.gte('day', from)
			.lt('day', to)
			.order('day', { ascending: true }),
		supabaseAdmin
			.from('books')
			.select('id')
			.gte('finished_at', from)
			.lt('finished_at', to),
	]);
	if (dayRows.error) throw new Error(`reading month query failed: ${dayRows.error.message}`);
	if (marked.error) throw new Error(`finished books query failed: ${marked.error.message}`);
	const markedFinished = ((marked.data ?? []) as { id: number }[]).map((row) => Number(row.id));

	const days = ((dayRows.data ?? []) as ReadingDay[]).map((row) => ({
		book_id: Number(row.book_id),
		day: String(row.day).slice(0, 10),
		pages: Number(row.pages),
		seconds: Number(row.seconds),
	}));
	if (days.length === 0) return { days, books: [], markedFinished };

	const ids = [...new Set(days.map((d) => d.book_id))];
	const { data, error } = await supabaseAdmin
		.from('book_detail')
		.select(
			'id, title, authors, cover_url, total_pages, furthest_page, finished_at, is_public, last_counted_day',
		)
		.in('id', ids);
	if (error) throw new Error(`month books query failed: ${error.message}`);

	const books = ((data ?? []) as Record<string, unknown>[]).map((row) => {
		const isPublic = row.is_public === true;
		return {
			id: Number(row.id),
			title: isPublic ? String(row.title ?? '') : '',
			authors: isPublic ? ((row.authors as string | null) ?? null) : null,
			cover_url: isPublic ? ((row.cover_url as string | null) ?? null) : null,
			total_pages: row.total_pages === null ? null : Number(row.total_pages),
			furthest_page: Number(row.furthest_page ?? 0),
			finished_at: (row.finished_at as string | null) ?? null,
			is_public: isPublic,
			// `last_counted_day` is max(book_days.day), so this is literally the last
			// day the book holds a cell on — not the day of its last session, which
			// since migration 0028 can be a two-page morning the grid never draws. An
			// inferred finish is dated from this, and has to land on a square.
			last_day: row.last_counted_day ? String(row.last_counted_day).slice(0, 10) : null,
		} satisfies MonthBook;
	});

	return { days, books, markedFinished };
}

/**
 * One month's page turns by local hour, midnight first.
 *
 * Reads `reading_hours_daily`, which applies the day minimum, so the band counts
 * exactly the reading the calendar grid above it draws. A card that disagreed
 * with itself between two panels an inch apart would be worse than no band.
 */
export async function getReadingMonthHours(key: string): Promise<number[]> {
	const { data, error } = await supabaseAdmin
		.from('reading_hours_daily')
		.select('hour, pages')
		.gte('day', `${key}-01`)
		.lt('day', `${shiftMonth(key, 1)}-01`);
	if (error) throw new Error(`reading month hours query failed: ${error.message}`);

	// A day-and-hour grid, so one hour arrives once per day it was read in.
	const hours = new Array<number>(24).fill(0);
	for (const row of data ?? []) {
		const hour = Number(row.hour);
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
		hours[hour] += Number(row.pages);
	}
	return hours;
}

/**
 * Distinct books read per "YYYY-MM", for the month picker's counts. Pages
 * explicitly: PostgREST caps an unbounded select at 1000 rows, and a truncated
 * count reads as a month with nothing in it.
 */
export async function countReadingByMonth(): Promise<Record<string, number>> {
	const PAGE = 1000;
	const seen: Record<string, Set<number>> = {};
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabaseAdmin
			.from('book_days')
			.select('book_id, day')
			.order('day', { ascending: true })
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(`countReadingByMonth failed: ${error.message}`);
		const rows = (data ?? []) as { book_id: number; day: string }[];
		for (const row of rows) {
			const month = monthOf(String(row.day));
			(seen[month] ??= new Set()).add(Number(row.book_id));
		}
		if (rows.length < PAGE) {
			return Object.fromEntries(Object.entries(seen).map(([month, ids]) => [month, ids.size]));
		}
	}
}

/**
 * Books in flight: unfinished, and touched inside the last 30 days. Newest
 * activity first.
 *
 * The recency window is what stops the list from being a graveyard — a book
 * abandoned in March is neither finished nor currently being read, and saying so
 * requires no extra state.
 */
export async function getCurrentlyReading(includePrivate = false): Promise<BookProgress[]> {
	const cutoff = new Date(Date.now() - CURRENTLY_READING_DAYS * 24 * 60 * 60 * 1000).toISOString();
	let q = supabaseAdmin
		.from('book_progress')
		.select('*')
		.is('finished_at', null)
		.gt('last_read_at', cutoff)
		.order('last_read_at', { ascending: false });
	if (!includePrivate) q = q.eq('is_public', true);

	const { data, error } = await q;
	if (error) throw new Error(`currently-reading query failed: ${error.message}`);
	return (data ?? []) as BookProgress[];
}

/**
 * Books left in the middle: unfinished, and untouched for longer than the
 * currently-reading window. Least stale first.
 *
 * The exact complement of getCurrentlyReading — between them every unfinished
 * book appears once, which is what stops a book abandoned in March from either
 * vanishing or pretending to be in progress.
 */
export async function getSetAside(includePrivate = false): Promise<BookProgress[]> {
	const cutoff = new Date(Date.now() - CURRENTLY_READING_DAYS * 24 * 60 * 60 * 1000).toISOString();
	let q = supabaseAdmin
		.from('book_progress')
		.select('*')
		.is('finished_at', null)
		.lte('last_read_at', cutoff)
		.order('last_read_at', { ascending: false });
	if (!includePrivate) q = q.eq('is_public', true);

	const { data, error } = await q;
	if (error) throw new Error(`set-aside query failed: ${error.message}`);
	return (data ?? []) as BookProgress[];
}

/**
 * Finished books, most recently finished first. `year` filters on the local
 * calendar year the book was finished in.
 */
export async function getFinished(year?: number, includePrivate = false): Promise<BookProgress[]> {
	let q = supabaseAdmin
		.from('book_progress')
		.select('*')
		.not('finished_at', 'is', null)
		.order('finished_at', { ascending: false });
	if (!includePrivate) q = q.eq('is_public', true);
	if (year != null) {
		q = q.gte('finished_at', `${year}-01-01`).lt('finished_at', `${year + 1}-01-01`);
	}

	const { data, error } = await q;
	if (error) throw new Error(`finished-books query failed: ${error.message}`);
	return (data ?? []) as BookProgress[];
}

/**
 * Finished books the Kindle knows nothing about, most recently finished first.
 *
 * The complement of getFinished: that one reads `book_progress`, which INNER
 * JOINs sessions and so cannot see these, and this one reads a view that
 * requires the absence of sessions. Every finished book comes back from exactly
 * one of them, which is what keeps the shelf from listing anything twice.
 *
 * These do NOT feed the streaks or the page totals — those measure the device,
 * and a book read in 2021 has no days or pages to contribute. See getStats.
 */
export async function getOfflineReads(
	year?: number,
	includePrivate = false,
): Promise<OfflineRead[]> {
	let q = supabaseAdmin
		.from('book_offline_reads')
		.select('*')
		.order('finished_at', { ascending: false });
	if (!includePrivate) q = q.eq('is_public', true);
	if (year != null) {
		q = q.gte('finished_at', `${year}-01-01`).lt('finished_at', `${year + 1}-01-01`);
	}

	const { data, error } = await q;
	if (error) throw new Error(`offline-reads query failed: ${error.message}`);
	return (data ?? []).map((r) => ({
		...(r as unknown as OfflineRead),
		rating: r.rating == null ? null : Number(r.rating),
		reads: Number(r.reads ?? 0),
	}));
}

/**
 * The to-read pile, most recently added first.
 *
 * `book_pile` (migration 0025) is what decides membership: added, unopened, not
 * started by hand, not finished. Nothing here re-checks any of that — a book
 * leaves the pile by acquiring a session, which is a fact about another table.
 */
export async function getToRead(includePrivate = false): Promise<PileBook[]> {
	let q = supabaseAdmin.from('book_pile').select('*').order('added_at', { ascending: false });
	if (!includePrivate) q = q.eq('is_public', true);

	const { data, error } = await q;
	if (error) throw new Error(`to-read query failed: ${error.message}`);
	return (data ?? []) as PileBook[];
}

/** Books started by hand, with nothing syncing pages. Most recent first. */
export async function getManualReads(includePrivate = false): Promise<ManualRead[]> {
	let q = supabaseAdmin
		.from('book_manual_reads')
		.select('*')
		.order('started_at', { ascending: false });
	if (!includePrivate) q = q.eq('is_public', true);

	const { data, error } = await q;
	if (error) throw new Error(`manual-reads query failed: ${error.message}`);
	return (data ?? []) as ManualRead[];
}

/**
 * Streaks and lifetime totals.
 *
 * Aggregated across every book, private ones included: the numbers say how much
 * was read, not what. Hiding a book from the shelf shouldn't silently break a
 * 200-day streak.
 */
export async function getStats(): Promise<ReadingStats> {
	const { data, error } = await supabaseAdmin.rpc('reading_stats');
	if (error) throw new Error(`reading stats query failed: ${error.message}`);

	const row = (Array.isArray(data) ? data[0] : data) as ReadingStats | undefined;
	return {
		current_streak: Number(row?.current_streak ?? 0),
		longest_streak: Number(row?.longest_streak ?? 0),
		days_read: Number(row?.days_read ?? 0),
		total_pages: Number(row?.total_pages ?? 0),
		total_seconds: Number(row?.total_seconds ?? 0),
		first_day: row?.first_day ?? null,
		last_day: row?.last_day ?? null,
	};
}
