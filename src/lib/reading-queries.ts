// Read side of the reading tracker: everything the eventual /reading page needs.
//
// All of it goes through supabaseAdmin. The reading tables have RLS on with no
// policies (migration 0020), so the anon client sees nothing — session rows are
// a precise log of when the owner is awake at night and never leave the server.
// What ships to the browser is what these helpers return: aggregates, and books
// that have opted in via `is_public`.
//
// Write side lives in src/lib/reading.ts.
import { supabaseAdmin } from './supabase';

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
	days_read: number;
	/** 0–1, clamped. Null when the book's page count is unknown. */
	progress: number | null;
}

/**
 * A finished book with no page turns behind it — read on paper, or before the
 * Kindle. Almost none of BookProgress applies: there is no furthest page, no
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
