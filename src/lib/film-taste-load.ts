import { yearOf } from './films';
import { placeFilms, type TastePoint } from './film-taste';
import { supabasePublic } from './supabase';

type Row = {
	rating: number | null;
	first_watched: string | null;
	movies: {
		tmdb_id: number;
		title: string;
		release_year: number | null;
		genres: string[] | null;
		keywords: string[] | null;
	};
};

/** Watched films placed in the taste space, for a calendar year (by first watch) or all time. */
export async function loadTasteSpace(scope: number | 'all'): Promise<TastePoint[]> {
	const all: Row[] = [];

	// Paged past PostgREST's 1,000-row cap.
	for (let from = 0; ; from += 1000) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select('rating, first_watched, movies!inner(tmdb_id, title, release_year, genres, keywords)')
			.order('movie_id')
			.range(from, from + 999)
			.overrideTypes<Row[], { merge: false }>();

		if (error) throw new Error(`loadTasteSpace failed: ${error.message}`);

		all.push(...data);

		if (data.length < 1000) break;
	}

	const rows = scope === 'all' ? all : all.filter((r) => yearOf(r.first_watched) === scope);

	return placeFilms(
		rows.map((r) => ({
			tmdbId: r.movies.tmdb_id,
			title: r.movies.title,
			year: r.movies.release_year,
			rating: r.rating,
			genres: r.movies.genres ?? [],
			keywords: r.movies.keywords ?? [],
		})),
	);
}
