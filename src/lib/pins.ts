// Pinned journal entries — the cross-section "favorites" replacement.
//
// A pin is just (track, ref_id): a pointer into one of the four logs. The rows
// live in `journal_pins` (migration 0047); this module is the only place that
// resolves them back into `JournalItem`s, applies the 10-pin cap, and enforces
// the same visitor privacy rules recent-journal.ts does.
//
// PRIVACY. recent-journal.ts is the template: films and meals are public;
// private books and private/hidden activities are DROPPED for a visitor, not
// blanked. A dropped pin never leaks a title. Reads go through supabaseAdmin so
// the owner can see everything; the drop happens in app code below.
//
// NO N+1. Pins are grouped by track and each track is one `.in('id', ids)`
// query, mapped through the existing journal-month mappers.
import { supabaseAdmin } from './supabase';
import type { JournalItem } from './journal-month';
import { filmItems, mealItems, activityItems } from './journal-month';
import { r2PublicUrl } from './r2';
import {
	MAX_PINS,
	PIN_TRACKS,
	capCheck,
	bookVisibleToVisitor,
	activityVisibleToVisitor,
	type PinTrack,
} from './pins-logic';

// The pure logic lives in pins-logic.ts (DB-free, so the test can import it);
// re-exported here so the whole contract reads off pins.ts.
export { MAX_PINS, PIN_TRACKS, capCheck, bookVisibleToVisitor, activityVisibleToVisitor };
export type { PinTrack };

export interface PinRow {
	track: PinTrack;
	refId: number;
	pinnedAt: string;
}

/** Thrown when a new pin would exceed MAX_PINS. Carries the current pinned
 *  items so the client can offer one to remove. Mirrors films.ts's
 *  FavoritesFullError, which carries nothing — this one has to, because the
 *  removal dialog needs the list. */
export class PinsFullError extends Error {
	readonly pins: JournalItem[];
	constructor(pins: JournalItem[]) {
		super(`You can pin at most ${MAX_PINS} entries.`);
		this.name = 'PinsFullError';
		this.pins = pins;
	}
}

// ---------------------------------------------------------------------------
// Pin rows
// ---------------------------------------------------------------------------

export async function listPinRows(): Promise<PinRow[]> {
	const { data, error } = await supabaseAdmin
		.from('journal_pins')
		.select('track, ref_id, pinned_at')
		.order('pinned_at', { ascending: false });
	if (error) throw new Error(`listPinRows failed: ${error.message}`);
	return ((data ?? []) as { track: PinTrack; ref_id: number; pinned_at: string }[]).map((r) => ({
		track: r.track,
		refId: Number(r.ref_id),
		pinnedAt: r.pinned_at,
	}));
}

export async function isPinned(track: PinTrack, refId: number): Promise<boolean> {
	const { data, error } = await supabaseAdmin
		.from('journal_pins')
		.select('id')
		.eq('track', track)
		.eq('ref_id', refId)
		.maybeSingle();
	if (error) throw new Error(`isPinned failed: ${error.message}`);
	return data != null;
}

export async function pin(track: PinTrack, refId: number): Promise<void> {
	const rows = await listPinRows();
	const already = rows.some((r) => r.track === track && r.refId === refId);
	if (capCheck(rows.length, already)) {
		throw new PinsFullError(await listPinnedItems({ isOwner: true }));
	}
	// Unique (track, ref_id) makes a re-pin a no-op; ignoreDuplicates keeps it
	// from touching pinned_at so the order doesn't jump on a double-tap.
	const { error } = await supabaseAdmin
		.from('journal_pins')
		.upsert({ track, ref_id: refId }, { onConflict: 'track,ref_id', ignoreDuplicates: true });
	if (error) throw new Error(`pin failed: ${error.message}`);
}

export async function unpin(track: PinTrack, refId: number): Promise<void> {
	const { error } = await supabaseAdmin
		.from('journal_pins')
		.delete()
		.eq('track', track)
		.eq('ref_id', refId);
	if (error) throw new Error(`unpin failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Resolving pins to items
// ---------------------------------------------------------------------------

async function filmPins(ids: number[]): Promise<JournalItem[]> {
	if (ids.length === 0) return [];
	// Same select/shape as films.ts listMonthWatches, by id instead of month.
	const { data, error } = await supabaseAdmin
		.from('logs')
		.select('id, watched_date, movies(tmdb_id, title, release_year, poster_path, runtime)')
		.in('id', ids)
		.is('deleted_at', null);
	if (error) throw new Error(`filmPins failed: ${error.message}`);
	const rows = (data ?? []) as unknown as {
		id: number;
		watched_date: string;
		movies: {
			tmdb_id: number;
			title: string;
			release_year: number | null;
			poster_path: string | null;
			runtime: number | null;
		} | null;
	}[];
	return filmItems(
		rows.flatMap((r) =>
			r.movies
				? [{
						id: r.id,
						watched_date: r.watched_date,
						tmdb_id: r.movies.tmdb_id,
						title: r.movies.title,
						release_year: r.movies.release_year,
						poster_path: r.movies.poster_path,
						runtime: r.movies.runtime,
						rating: null,
					}]
				: [],
		),
	);
}

async function bookPins(ids: number[], isOwner: boolean): Promise<JournalItem[]> {
	if (ids.length === 0) return [];
	const { data, error } = await supabaseAdmin
		.from('book_detail')
		.select('id, title, authors, cover_url, is_public, last_counted_day, finished_at')
		.in('id', ids);
	if (error) throw new Error(`bookPins failed: ${error.message}`);
	const rows = (data ?? []) as {
		id: number;
		title: string | null;
		authors: string | null;
		cover_url: string | null;
		is_public: boolean;
		last_counted_day: string | null;
		finished_at: string | null;
	}[];
	return rows
		.filter((b) => isOwner || bookVisibleToVisitor(b))
		.map((b) => ({
			track: 'book' as const,
			key: String(b.id),
			// A pinned book is a book, not a book-day: date it by its most recent
			// reading day, falling back to its finish date, else today.
			day: (b.last_counted_day ?? b.finished_at ?? new Date().toISOString()).slice(0, 10),
			minutes: 0,
			title: b.title ?? 'A book',
			detail: b.authors ?? 'Book',
			// Same Open Library size-swap the bookItems mapper applies.
			image: b.cover_url ? b.cover_url.replace(/-(S|M|L)\.jpg$/i, '-M.jpg') : null,
			aspect: 2 / 3,
			route: null,
			icon: null,
			href: `/books/${b.id}`,
		}));
}

async function mealPins(ids: number[]): Promise<JournalItem[]> {
	if (ids.length === 0) return [];
	const [visits, photos] = await Promise.all([
		supabaseAdmin.from('restaurant_diary').select('*').in('id', ids),
		supabaseAdmin
			.from('restaurant_photos')
			.select('visit_id, storage_path, width, height, position')
			.in('visit_id', ids)
			.order('position')
			.order('id'),
	]);
	if (visits.error) throw new Error(`mealPins failed: ${visits.error.message}`);
	if (photos.error) throw new Error(`mealPins photos failed: ${photos.error.message}`);
	const byVisit = new Map<number, { url: string; width: number | null; height: number | null }[]>();
	for (const p of (photos.data ?? []) as {
		visit_id: number;
		storage_path: string;
		width: number | null;
		height: number | null;
	}[]) {
		const list = byVisit.get(p.visit_id) ?? [];
		list.push({ url: r2PublicUrl(p.storage_path), width: p.width, height: p.height });
		byVisit.set(p.visit_id, list);
	}
	const rows = (visits.data ?? []) as {
		id: number;
		visited_on: string;
		restaurant_name: string;
		cuisines: string[] | null;
		tags: string[] | null;
		neighborhood: string | null;
	}[];
	return mealItems(rows.map((v) => ({ ...v, photos: byVisit.get(v.id) ?? [] })));
}

async function movePins(ids: number[], isOwner: boolean): Promise<JournalItem[]> {
	if (ids.length === 0) return [];
	const { data, error } = await supabaseAdmin.from('activity_list').select('*').in('id', ids);
	if (error) throw new Error(`movePins failed: ${error.message}`);
	const rows = (data ?? []) as {
		id: number;
		sport: string;
		title: string;
		local_date: string;
		moving_seconds: number | null;
		elapsed_seconds: number;
		route_path: string | null;
		private: boolean;
		hide_from_review: boolean;
	}[];
	// Drop private/hidden entirely for a visitor — recent-journal.ts's rule.
	return activityItems(rows.filter((a) => isOwner || activityVisibleToVisitor(a)));
}

/**
 * The pinned entries as `JournalItem`s, newest first by the entry's own day.
 * Optionally narrowed to one track. Dangling pins (entry deleted) fall out
 * naturally: the `.in` query never returns them.
 */
export async function listPinnedItems(opts: { isOwner: boolean; track?: PinTrack }): Promise<JournalItem[]> {
	const rows = await listPinRows();
	const wanted = opts.track ? rows.filter((r) => r.track === opts.track) : rows;
	const ids = (t: PinTrack) => wanted.filter((r) => r.track === t).map((r) => r.refId);

	const [films, books, meals, moves] = await Promise.all([
		filmPins(ids('film')),
		bookPins(ids('book'), opts.isOwner),
		mealPins(ids('meal')),
		movePins(ids('move'), opts.isOwner),
	]);

	// The one sort. Newest by the entry's day, ties broken stably. The lead may
	// switch this to pin time later — change it here.
	return [...films, ...books, ...meals, ...moves].sort(
		(a, b) => b.day.localeCompare(a.day) || a.track.localeCompare(b.track) || a.key.localeCompare(b.key),
	);
}
