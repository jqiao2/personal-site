// Read and write side of one book's page.
//
// Sibling to books-queries.ts, which serves the shelf. Same posture: the
// reading tables have RLS on with no policies (migration 0020), so everything
// goes through supabaseAdmin and nothing reaches the browser except what these
// helpers return. `is_public` is enforced here rather than in the page — a
// private book must 404, and the surest way to guarantee that is for the query
// to refuse to hand it over.
//
// Presentation lives in book-view.ts; this module returns rows.
import { supabaseAdmin } from './supabase';

/** Vocabulary the review dialog offers. The API rejects anything outside it. */
export const PACING = ['Slow', 'Moderate', 'Fast', 'Page-Turner'] as const;
export const FOCUS = ['Character-Driven', 'A bit of both', 'Plot-Driven'] as const;
export const MOODS = [
	'Cozy',
	'Inspiring',
	'Emotional',
	'Funny',
	'Dark',
	'Tense',
	'Mysterious',
	'Sad',
	'Magical',
	'Nostalgic',
	'Bittersweet',
] as const;
export const TONES = [
	'Atmospheric',
	'Immersive',
	'Grounded',
	'Informative',
	'Dreamlike',
	'Gritty',
	'Gothic',
	'Eerie',
	'Adventurous',
	'Reflective',
	'Cynical',
	'Witty',
	'Lighthearted',
	'Serious',
] as const;

/**
 * Every attribute in one list, in the order the page prints them.
 *
 * The dialog groups them under four labels; the review that comes back out is a
 * row of chips with no labels on it, and reading "Slow · Character-Driven ·
 * Dark · Gothic" only works if the scales come first and the order never moves
 * between reviews. Selection order would reshuffle them per review.
 */
export const VOCABULARY: string[] = [...PACING, ...FOCUS, ...MOODS, ...TONES];

export interface BookRow {
	id: number;
	md5: string | null;
	/** As the source recorded it, digits only. A search key, not a unique one. */
	isbn: string | null;
	/** Corrected title where one exists, KOReader's otherwise. */
	title: string;
	authors: string | null;
	/** What KOReader calls the file. Not for display — it's the identifier. */
	source_title: string;
	subtitle: string | null;
	/** "Ken Liu (Translator)" — credits, kept out of the byline. */
	contributors: string[];
	series: string | null;
	language: string | null;
	total_pages: number | null;
	/** The printed edition's length, for drawing the spine. See migration 0026. */
	ol_pages: number | null;
	cover_url: string | null;
	ol_key: string | null;
	first_published: string | null;
	kind: string | null;
	genres: string[];
	description: string[];
	is_public: boolean;
	added_at: string | null;
	/** Set when reading began away from any device. See migration 0025. */
	started_at: string | null;
	finished_at: string | null;
	finished_by_hand: boolean;
	gave_up_at: string | null;
	furthest_page: number;
	distinct_pages_read: number;
	seconds_read: number;
	first_read_at: string | null;
	last_read_at: string | null;
	/**
	 * Days that cleared the minimum, so this matches the activity strip rather
	 * than `last_read_at` — the page counts beside it still count every page.
	 */
	days_read: number;
}

export interface BookDay {
	/** YYYY-MM-DD, local (America/New_York — see migration 0020). */
	day: string;
	pages: number;
	seconds: number;
	/**
	 * Whether the day cleared the minimum (migration 0028) and so counts towards
	 * the shelf-wide grid, the streaks and the month card. False days are drawn
	 * on this page and nowhere else. Decided in SQL — the threshold has one home.
	 */
	counts: boolean;
}

export interface ReviewRow {
	id: number;
	read_from: string;
	read_to: string;
	rating: number | null;
	loved: boolean;
	gave_up: boolean;
	review_text: string | null;
	pacing: string | null;
	focus: string | null;
	moods: string[];
	tones: string[];
}

export interface HighlightRow {
	page: number;
	text: string;
}

/**
 * One book, or null when there isn't one to show.
 *
 * `includePrivate` is the owner check, and null is the answer for both "no such
 * book" and "private, and you are not the owner" — the page turns either into
 * the same 404. Distinguishing them in the response would be a way of asking
 * whether a book exists, which is the thing being hidden.
 */
export async function getBook(id: number, includePrivate = false): Promise<BookRow | null> {
	let q = supabaseAdmin.from('book_detail').select('*').eq('id', id);
	if (!includePrivate) q = q.eq('is_public', true);

	const { data, error } = await q.maybeSingle();
	if (error) throw new Error(`book lookup failed: ${error.message}`);
	if (!data) return null;

	const row = data as Record<string, unknown>;
	return {
		...(row as unknown as BookRow),
		contributors: (row.contributors as string[]) ?? [],
		genres: (row.genres as string[]) ?? [],
		description: (row.description as string[]) ?? [],
		furthest_page: Number(row.furthest_page ?? 0),
		distinct_pages_read: Number(row.distinct_pages_read ?? 0),
		seconds_read: Number(row.seconds_read ?? 0),
		days_read: Number(row.days_read ?? 0),
	};
}

/**
 * Every day this book was opened on, oldest first — the small ones included.
 *
 * Reads `book_days_all` rather than `book_days`, which is the one place on the
 * site that does. Everything that aggregates across books applies the minimum
 * and drops the two-page mornings; a book's own page is the record of when it
 * was open, so it keeps them and says which ones did not count.
 */
export async function getBookDays(bookId: number): Promise<BookDay[]> {
	const { data, error } = await supabaseAdmin
		.from('book_days_all')
		.select('day, pages, seconds, counts')
		.eq('book_id', bookId)
		.order('day', { ascending: true });
	if (error) throw new Error(`book days query failed: ${error.message}`);

	return (data ?? []).map((d) => ({
		day: String(d.day).slice(0, 10),
		pages: Number(d.pages),
		seconds: Number(d.seconds),
		counts: d.counts === true,
	}));
}

/** A book's page turns by local hour, with the sittings behind each one. */
export interface BookHours {
	/** 24 counts, midnight first. */
	hours: number[];
	/** How many sittings touched each hour. Sums to more than `sittings`. */
	spread: number[];
	/** Sittings over the book's whole life — the tooltip's denominator. */
	sittings: number;
}

/**
 * When this book was read, on the clock.
 *
 * Unfiltered by the day minimum, matching `getBookDays` above and for the same
 * reason: the small mornings are part of the record of when the book was open.
 */
export async function getBookHours(bookId: number): Promise<BookHours> {
	const [rows, total] = await Promise.all([
		supabaseAdmin.from('book_hours').select('hour, pages, sittings').eq('book_id', bookId),
		supabaseAdmin.from('book_sitting_counts').select('sittings').eq('book_id', bookId).maybeSingle(),
	]);
	if (rows.error) throw new Error(`book hours query failed: ${rows.error.message}`);
	if (total.error) throw new Error(`book sittings query failed: ${total.error.message}`);

	const hours = new Array<number>(24).fill(0);
	const spread = new Array<number>(24).fill(0);
	for (const row of rows.data ?? []) {
		const hour = Number(row.hour);
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
		hours[hour] = Number(row.pages);
		spread[hour] = Number(row.sittings);
	}
	return { hours, spread, sittings: Number(total.data?.sittings ?? 0) };
}

/** Reviews for a book, newest read first. */
export async function getBookReviews(bookId: number): Promise<ReviewRow[]> {
	const { data, error } = await supabaseAdmin
		.from('book_reviews')
		.select('id, read_from, read_to, rating, loved, gave_up, review_text, pacing, focus, moods, tones')
		.eq('book_id', bookId)
		.order('read_to', { ascending: false });
	if (error) throw new Error(`book reviews query failed: ${error.message}`);

	return (data ?? []).map((r) => ({
		...(r as unknown as ReviewRow),
		rating: r.rating == null ? null : Number(r.rating),
		moods: (r.moods as string[]) ?? [],
		tones: (r.tones as string[]) ?? [],
	}));
}

/** Highlights in page order. Empty until the KOReader plugin starts sending them. */
export async function getBookHighlights(bookId: number): Promise<HighlightRow[]> {
	const { data, error } = await supabaseAdmin
		.from('book_highlights')
		.select('page, text')
		.eq('book_id', bookId)
		.order('page', { ascending: true });
	if (error) throw new Error(`book highlights query failed: ${error.message}`);
	return (data ?? []).map((h) => ({ page: Number(h.page), text: String(h.text) }));
}

/** Patch a book's owner-only columns. Callers have already validated the values. */
export async function updateBook(id: number, patch: Record<string, unknown>): Promise<void> {
	const { error } = await supabaseAdmin
		.from('books')
		.update({ ...patch, updated_at: new Date().toISOString() })
		.eq('id', id);
	if (error) throw new Error(`book update failed: ${error.message}`);
}

/**
 * Fold the Kindle's row for a book into the hand-typed one and delete it.
 *
 * All of the work is in `merge_book` (migration 0025): five statements that have
 * to land together, one of which frees a unique md5 for another to claim.
 */
export async function mergeBook(targetId: number, sourceId: number): Promise<void> {
	const { error } = await supabaseAdmin.rpc('merge_book', {
		p_target: targetId,
		p_source: sourceId,
	});
	if (error) throw new Error(`merge failed: ${error.message}`);
}

export interface ReviewInput {
	read_from: string;
	read_to: string;
	rating: number | null;
	loved: boolean;
	gave_up: boolean;
	review_text: string | null;
	pacing: string | null;
	focus: string | null;
	moods: string[];
	tones: string[];
}

/**
 * Insert or update the review for one read.
 *
 * Keyed on (book_id, read_from) rather than the review's own id so that saving
 * twice from a page that has gone stale updates the read it names instead of
 * quietly opening a second review of it.
 */
export async function saveReview(bookId: number, input: ReviewInput): Promise<void> {
	const { error } = await supabaseAdmin.from('book_reviews').upsert(
		{ book_id: bookId, ...input, updated_at: new Date().toISOString() },
		{ onConflict: 'book_id,read_from' },
	);
	if (error) throw new Error(`review save failed: ${error.message}`);
}

export async function deleteReview(bookId: number, reviewId: number): Promise<boolean> {
	const { data, error } = await supabaseAdmin
		.from('book_reviews')
		.delete()
		.eq('id', reviewId)
		.eq('book_id', bookId)
		.select('id')
		.maybeSingle();
	if (error) throw new Error(`review delete failed: ${error.message}`);
	return !!data;
}
