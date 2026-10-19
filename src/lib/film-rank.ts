// Reads and writes the owner's film ranking (0076). The comparison logic lives
// in film-rank-pick.ts.
import type { RankFilm } from './film-rank-pick';
import { supabaseAdmin } from './supabase';
import { imageUrl } from './tmdb';

type Row = {
	movies: {
		id: number;
		title: string;
		release_year: number | null;
		poster_path: string | null;
		directors: string[] | null;
		actors: string[] | null;
		genres: string[] | null;
	};
};

/** Every watched film, plus the saved order (best first) trimmed to films still watched. */
export async function loadRanking(): Promise<{ films: RankFilm[]; order: number[] }> {
	const rows: Row[] = [];

	// Paged past PostgREST's 1,000-row cap.
	for (let from = 0; ; from += 1000) {
		const { data, error } = await supabaseAdmin
			.from('watched')
			.select('movies!inner(id, title, release_year, poster_path, directors, actors, genres)')
			.order('movie_id')
			.range(from, from + 999)
			.overrideTypes<Row[], { merge: false }>();

		if (error) throw new Error(`loadRanking failed: ${error.message}`);

		rows.push(...data);

		if (data.length < 1000) break;
	}

	const { data: saved, error } = await supabaseAdmin
		.from('film_ranking')
		.select('movie_ids')
		.eq('id', 1)
		.maybeSingle();

	if (error) throw new Error(`loadRanking failed: ${error.message}`);

	const films = rows.map(({ movies: m }) => ({
		id: m.id,
		title: m.title,
		year: m.release_year,
		poster: imageUrl(m.poster_path, 'w342'),
		directors: m.directors ?? [],
		// Top-billed only: a bit part shared with another film says little.
		actors: (m.actors ?? []).slice(0, 5),
		genres: m.genres ?? [],
	}));

	const watched = new Set(films.map((f) => f.id));

	// SAFETY: movie_ids is `integer[] not null` (0076).
	return { films, order: ((saved?.movie_ids ?? []) as number[]).filter((id) => watched.has(id)) };
}

export async function saveRanking(order: number[]): Promise<void> {
	const { error } = await supabaseAdmin
		.from('film_ranking')
		.upsert({ id: 1, movie_ids: order, updated_at: new Date().toISOString() });

	if (error) throw new Error(`saveRanking failed: ${error.message}`);
}
