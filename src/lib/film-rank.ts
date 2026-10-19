// Reads and writes the owner's film ranking (0076). The comparison logic lives
// in film-rank-pick.ts.
import type { RankFilm } from './film-rank-pick';
import { formatWatchedDate, starText } from './format';
import { supabaseAdmin } from './supabase';
import { imageUrl } from './tmdb';

/** One diary entry, formatted for the card. */
export interface RankEntry {
	date: string | null;
	stars: string | null;
	review: string | null;
	note: string | null;
}

/** A film as the page shows it: what the comparison needs, plus how it was logged. */
export interface RankCard extends RankFilm {
	tmdbId: number;
	stars: string | null;
	liked: boolean;
	/** Newest first. */
	entries: RankEntry[];
}

type Row = {
	rating: number | null;
	liked: boolean | null;
	movies: {
		id: number;
		tmdb_id: number;
		title: string;
		release_year: number | null;
		poster_path: string | null;
		directors: string[] | null;
		actors: string[] | null;
		genres: string[] | null;
	};
};

type LogRow = {
	movie_id: number;
	watched_date: string | null;
	rating: number | null;
	review_text: string | null;
	private_note: string | null;
};

/** Every watched film, plus the saved order (best first) trimmed to films still watched. */
export async function loadRanking(): Promise<{ films: RankCard[]; order: number[] }> {
	const rows: Row[] = [];

	// Paged past PostgREST's 1,000-row cap.
	for (let from = 0; ; from += 1000) {
		const { data, error } = await supabaseAdmin
			.from('watched')
			.select('rating, liked, movies!inner(id, tmdb_id, title, release_year, poster_path, directors, actors, genres)')
			.order('movie_id')
			.range(from, from + 999)
			.overrideTypes<Row[], { merge: false }>();

		if (error) throw new Error(`loadRanking failed: ${error.message}`);

		rows.push(...data);

		if (data.length < 1000) break;
	}

	const [{ data: saved, error }, entries] = await Promise.all([
		supabaseAdmin.from('film_ranking').select('movie_ids').eq('id', 1).maybeSingle(),
		loadEntries(),
	]);

	if (error) throw new Error(`loadRanking failed: ${error.message}`);

	const films = rows.map(({ rating, liked, movies: m }) => ({
		id: m.id,
		tmdbId: m.tmdb_id,
		title: m.title,
		year: m.release_year,
		poster: imageUrl(m.poster_path, 'w342'),
		directors: m.directors ?? [],
		// Top-billed only: a bit part shared with another film says little.
		actors: (m.actors ?? []).slice(0, 5),
		genres: m.genres ?? [],
		stars: starText(rating),
		liked: liked === true,
		entries: entries.get(m.id) ?? [],
	}));

	const watched = new Set(films.map((f) => f.id));

	// SAFETY: movie_ids is `integer[] not null` (0076).
	return { films, order: ((saved?.movie_ids ?? []) as number[]).filter((id) => watched.has(id)) };
}

/** Live diary entries by movies.id, newest first. */
async function loadEntries(): Promise<Map<number, RankEntry[]>> {
	const byFilm = new Map<number, RankEntry[]>();

	for (let from = 0; ; from += 1000) {
		const { data, error } = await supabaseAdmin
			.from('logs')
			.select('movie_id, watched_date, rating, review_text, private_note')
			.is('deleted_at', null)
			.order('watched_date', { ascending: false, nullsFirst: false })
			.order('id', { ascending: false })
			.range(from, from + 999)
			.overrideTypes<LogRow[], { merge: false }>();

		if (error) throw new Error(`loadRanking failed: ${error.message}`);

		for (const l of data) {
			const list = byFilm.get(l.movie_id) ?? [];

			list.push({
				date: formatWatchedDate(l.watched_date),
				stars: starText(l.rating),
				review: l.review_text?.trim() || null,
				note: l.private_note?.trim() || null,
			});
			byFilm.set(l.movie_id, list);
		}

		if (data.length < 1000) break;
	}

	return byFilm;
}

export async function saveRanking(order: number[]): Promise<void> {
	const { error } = await supabaseAdmin
		.from('film_ranking')
		.upsert({ id: 1, movie_ids: order, updated_at: new Date().toISOString() });

	if (error) throw new Error(`saveRanking failed: ${error.message}`);
}
