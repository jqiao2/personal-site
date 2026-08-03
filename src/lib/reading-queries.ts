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
	title: string;
	authors: string | null;
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
const CURRENTLY_READING_DAYS = 30;

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
