import { yearOf } from './films';
import { placeFilms, type TastePoint } from './film-taste';
import { supabasePublic } from './supabase';

type Row = {
	rating: number | null;
	first_watched: string | null;
	movies: { tmdb_id: number; title: string; release_year: number | null; genres: string[] | null };
};

/**
 * Watched films placed in the taste space, for a calendar year (by first watch)
 * or all time. The vote count comes from credit_films, which the credit sync
 * fills for every film logged; the rare film missing there is left out.
 */
export async function loadTasteSpace(scope: number | 'all'): Promise<TastePoint[]> {
	const all: Row[] = [];

	// Paged past PostgREST's 1,000-row cap.
	for (let from = 0; ; from += 1000) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select('rating, first_watched, movies!inner(tmdb_id, title, release_year, genres)')
			.order('movie_id')
			.range(from, from + 999)
			.overrideTypes<Row[], { merge: false }>();

		if (error) throw new Error(`loadTasteSpace failed: ${error.message}`);

		all.push(...data);

		if (data.length < 1000) break;
	}

	const rows = scope === 'all' ? all : all.filter((r) => yearOf(r.first_watched) === scope);
	const ids = rows.map((r) => r.movies.tmdb_id);
	const votes = new Map<number, number>();

	// Chunked: an `in` list of 1k ids is a long URL, and the reply would hit the row cap.
	for (let i = 0; i < ids.length; i += 500) {
		const { data, error } = await supabasePublic
			.from('credit_films')
			.select('tmdb_id, vote_count')
			.in('tmdb_id', ids.slice(i, i + 500));

		if (error) throw new Error(`loadTasteSpace votes failed: ${error.message}`);

		for (const c of data) votes.set(c.tmdb_id, c.vote_count);
	}

	return placeFilms(
		rows
			.filter((r) => votes.has(r.movies.tmdb_id))
			.map((r) => ({
				tmdbId: r.movies.tmdb_id,
				title: r.movies.title,
				year: r.movies.release_year,
				rating: r.rating,
				genres: r.movies.genres ?? [],
				votes: votes.get(r.movies.tmdb_id) ?? 0,
			})),
	);
}
