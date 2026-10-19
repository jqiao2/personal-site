// Film lists at /films/lists (migration 0077).
//
// A hand-picked list is its film_list_items rows in `position` order. A smart list
// is a saved /films/watched query string, read through the same parser and query
// the grid uses — so "everything starring Scarlett Johansson" is exactly what the
// grid shows for `?actor=Scarlett+Johansson`, today and after the next log.
import { z } from 'astro/zod';
import { listWatchedPage, type WatchlistTile } from './films';
import { supabaseAdmin, supabasePublic } from './supabase';
import { watchedQueryFromParams } from './watched-params';

export interface FilmList {
	id: number;
	name: string;
	description: string | null;
	/** A /films/watched query string (no `?`) for a smart list; null for a hand-picked one. */
	query: string | null;
	position: number;
}

export interface FilmListFilm extends WatchlistTile {
	rating?: number | null;
}

export interface FilmListSummary extends FilmList {
	total: number;
	/** The first few posters, for the index's preview strip. */
	preview: FilmListFilm[];
}

const LIST_COLUMNS = 'id, name, description, query, position';

const itemRows = z.array(
	z.object({
		movies: z.object({
			tmdb_id: z.number(),
			title: z.string(),
			release_year: z.number().nullable(),
			poster_path: z.string().nullable(),
		}),
	}),
);

/** One list's films, and how many there are. Smart lists cap at PostgREST's 1000 rows. */
async function filmsOf(list: FilmList, isOwner: boolean, limit: number): Promise<{ films: FilmListFilm[]; total: number }> {
	if (list.query != null) {
		return listWatchedPage({ ...watchedQueryFromParams(new URLSearchParams(list.query)), limit }, isOwner);
	}

	const { data, error, count } = await supabasePublic
		.from('film_list_items')
		.select('position, movies!inner(tmdb_id, title, release_year, poster_path)', { count: 'exact' })
		.eq('list_id', list.id)
		.order('position')
		.order('added_at')
		.limit(limit);

	if (error) throw new Error(`film list items failed: ${error.message}`);

	// The client types a to-one embed as an array; it arrives as one object.
	const films = itemRows.parse(data ?? []).map((r) => r.movies);

	return { films, total: count ?? 0 };
}

/** Every list, in the owner's order, each with its count and a poster preview. */
export async function listFilmLists(isOwner: boolean): Promise<FilmListSummary[]> {
	const { data, error } = await supabasePublic
		.from('film_lists')
		.select(LIST_COLUMNS)
		.order('position')
		.order('id');

	if (error) throw new Error(`listFilmLists failed: ${error.message}`);

	// SAFETY: LIST_COLUMNS names exactly FilmList's columns.
	const lists = (data ?? []) as FilmList[];

	// ponytail: one films query per list; fine for tens of lists, batch if it grows to hundreds.
	return Promise.all(
		lists.map(async (list) => {
			const { films, total } = await filmsOf(list, isOwner, 5);

			return { ...list, total, preview: films };
		}),
	);
}

/** One list and all of its films, or null if there's no such list. */
export async function getFilmList(
	id: number,
	isOwner: boolean,
): Promise<{ list: FilmList; films: FilmListFilm[]; total: number } | null> {
	const { data, error } = await supabasePublic.from('film_lists').select(LIST_COLUMNS).eq('id', id).maybeSingle();

	if (error) throw new Error(`getFilmList failed: ${error.message}`);

	if (!data) return null;
	// SAFETY: LIST_COLUMNS names exactly FilmList's columns.
	const list = data as FilmList;

	return { list, ...(await filmsOf(list, isOwner, 1000)) };
}

/** Hand-picked lists only — the ones a film can be added to by hand. */
export async function listManualLists(): Promise<{ id: number; name: string }[]> {
	const { data, error } = await supabasePublic
		.from('film_lists')
		.select('id, name')
		.is('query', null)
		.order('position')
		.order('id');

	if (error) throw new Error(`listManualLists failed: ${error.message}`);

	return data ?? [];
}

/** Ids of the hand-picked lists a movie (local id) is on. */
export async function listIdsContaining(movieId: number): Promise<number[]> {
	const { data, error } = await supabasePublic.from('film_list_items').select('list_id').eq('movie_id', movieId);

	if (error) throw new Error(`listIdsContaining failed: ${error.message}`);

	return (data ?? []).map((r) => Number(r.list_id));
}

/** Next free position at the end of a table's ordering (lists, or one list's items). */
export async function nextPosition(table: 'film_lists' | 'film_list_items', listId?: number): Promise<number> {
	let req = supabaseAdmin.from(table).select('position').order('position', { ascending: false }).limit(1);

	if (listId != null) req = req.eq('list_id', listId);
	const { data, error } = await req;

	if (error) throw new Error(`nextPosition failed: ${error.message}`);

	return (data?.[0]?.position ?? -1) + 1;
}

/**
 * A smart-list query string as it should be stored: the grid's params minus the
 * paging ones, so the saved list doesn't depend on where you'd scrolled to.
 */
export function cleanListQuery(raw: string): string {
	const p = new URLSearchParams(raw.replace(/^\?/, ''));

	for (const k of ['limit', 'offset', 'list']) p.delete(k);

	return p.toString();
}

/** Whether a list exists and is hand-picked — the only kind that holds items. */
export async function isManualList(id: number): Promise<boolean> {
	const { data, error } = await supabaseAdmin.from('film_lists').select('id').eq('id', id).is('query', null).maybeSingle();

	if (error) throw new Error(`isManualList failed: ${error.message}`);

	return data != null;
}

/** Local movie ids keyed by TMDB id, for the films that are cached. */
export async function movieIdsByTmdb(tmdbIds: number[]): Promise<Map<number, number>> {
	const { data, error } = await supabaseAdmin.from('movies').select('id, tmdb_id').in('tmdb_id', tmdbIds);

	if (error) throw new Error(`movieIdsByTmdb failed: ${error.message}`);

	return new Map((data ?? []).map((m) => [Number(m.tmdb_id), Number(m.id)]));
}
