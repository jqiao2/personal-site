// /log — every film, reading day, meal and activity ever logged, as the home
// feed's rows, fifteen to a page.
//
// Two passes, so a page never pays for the whole log's posters and routes:
//
//   1. THE INDEX. Every entry's (track, key, day, logged) — four narrow selects,
//      paged past PostgREST's 1000-row cap (wiki 0017). Sorted, that gives the
//      page count and exactly which entries fall on the requested page.
//   2. THE PAGE. The months those entries sit in are read in full through
//      monthItemsPublic — the same visitor-safe read the home feed uses — and
//      cut down to the page's entries. A page is usually one or two months.
//
// The index applies the same visibility rules as monthItemsPublic (public books
// only; activities published or, for the owner, all — minus any held back from
// the review), so the count and the rows cannot disagree. Pass 2 is the one
// that actually guards what a visitor sees; the index only decides the order.

import type { JournalItem } from './journal-month';
import { monthOf } from './share-card';
import { supabaseAdmin, supabasePublic } from './supabase';
import { monthItemsPublic } from './recent-journal';
import { compareEntries, entryId, pageCount, pageSlice, type LogEntry } from './journal-log-page';

const CAP = 1000;

type Query = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

/** Every row a query returns, a thousand at a time. The query must carry a
 *  stable order or `.range()` pages overlap. */
async function all<T>(label: string, query: Query): Promise<T[]> {
	const rows: T[] = [];

	for (let offset = 0; ; offset += CAP) {
		const { data, error } = await query(offset, offset + CAP - 1);

		if (error) throw new Error(`${label} index failed: ${error.message}`);
		// SAFETY: T is the row shape of the columns the caller's select names.
		rows.push(...((data ?? []) as T[]));

		if (!data || data.length < CAP) return rows;
	}
}

async function filmEntries(): Promise<LogEntry[]> {
	const rows = await all<{ id: number; watched_date: string; created_at: string }>('films', (a, b) =>
		supabasePublic
			.from('logs')
			.select('id, watched_date, created_at')
			.is('deleted_at', null)
			.order('id')
			.range(a, b),
	);

	return rows.map((r) => ({ track: 'film', key: String(r.id), day: r.watched_date, logged: r.created_at }));
}

async function bookEntries(): Promise<LogEntry[]> {
	const [days, books] = await Promise.all([
		all<{ book_id: number; day: string }>('reading', (a, b) =>
			supabaseAdmin.from('book_days').select('book_id, day').order('day').order('book_id').range(a, b),
		),
		all<{ id: number; is_public: boolean }>('books', (a, b) =>
			supabaseAdmin.from('book_detail').select('id, is_public').order('id').range(a, b),
		),
	]);

	const open = new Set(books.filter((b) => b.is_public === true).map((b) => Number(b.id)));

	return days
		.filter((d) => open.has(Number(d.book_id)))
		.map((d) => {
			const day = String(d.day).slice(0, 10);

			return { track: 'book', key: `${Number(d.book_id)}:${day}`, day, logged: day };
		});
}

async function mealEntries(): Promise<LogEntry[]> {
	const rows = await all<{ id: number; visited_on: string; created_at: string }>('meals', (a, b) =>
		supabasePublic.from('restaurant_diary').select('id, visited_on, created_at').order('id').range(a, b),
	);

	return rows.map((r) => ({ track: 'meal', key: String(r.id), day: r.visited_on, logged: r.created_at }));
}

async function moveEntries(isOwner: boolean): Promise<LogEntry[]> {
	const rows = await all<{
		id: number;
		local_date: string;
		started_at: string;
		private: boolean | null;
		hide_from_review: boolean | null;
	}>('activities', (a, b) =>
		supabasePublic
			.from('activity_list')
			.select('id, local_date, started_at, private, hide_from_review')
			.is('parent_id', null)
			.order('id')
			.range(a, b),
	);

	return rows
		.filter((r) => (isOwner || r.private === false) && !r.hide_from_review)
		.map((r) => ({ track: 'move', key: String(r.id), day: r.local_date, logged: r.started_at }));
}

export interface LogPage {
	items: JournalItem[];
	page: number;
	pages: number;
	total: number;
}

/** One page of the whole log, newest first. A page past the end comes back
 *  empty with the real page count, for the route to 404 on. */
export async function journalPage(page: number, isOwner = false): Promise<LogPage> {
	const index = (
		await Promise.all([filmEntries(), bookEntries(), mealEntries(), moveEntries(isOwner)])
	).flat();

	index.sort(compareEntries);

	const pages = pageCount(index.length);
	const slice = pageSlice(index, page);

	if (slice.length === 0) return { items: [], page, pages, total: index.length };

	const wanted = new Set(slice.map(entryId));
	const months = [...new Set(slice.map((e) => monthOf(e.day)))];
	const read = await Promise.all(months.map((k) => monthItemsPublic(k, isOwner)));

	const items = read
		.flat()
		.filter((it) => wanted.has(entryId(it)))
		.sort(compareEntries);

	return { items, page, pages, total: index.length };
}
