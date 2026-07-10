// One-off correction: the Letterboxd backfill (scripts/backfill-letterboxd.mjs)
// linked "Obsession" (2025) to TMDB id 1436161, an unrelated short film. The
// correct film is Blumhouse's "Obsession" (TMDB id 1339713), which Letterboxd
// lists under 2025 but TMDB lists as a 2026 release — the year-scoped search
// picked the wrong same-title hit. Confirmed against the existing log's watched
// date (2026-05-19) and review text, which match the Blumhouse film.
//
// Usage: node --env-file=.env scripts/fix-obsession-tmdb-id.mjs

import { createClient } from '@supabase/supabase-js';

const MOVIE_ID = 989; // movies.id for the mislinked "Obsession" row
const CORRECT_TMDB_ID = 1339713;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const url = new URL(`https://api.themoviedb.org/3/movie/${CORRECT_TMDB_ID}`);
url.searchParams.set('api_key', process.env.TMDB_API_KEY);
const d = await (await fetch(url)).json();

const { data, error } = await sb
	.from('movies')
	.update({
		tmdb_id: d.id,
		title: d.title,
		release_year: d.release_date ? Number(d.release_date.slice(0, 4)) || null : null,
		poster_path: d.poster_path,
		backdrop_path: d.backdrop_path,
		overview: d.overview || null,
		runtime: d.runtime ?? null,
		last_synced_at: new Date().toISOString(),
	})
	.eq('id', MOVIE_ID)
	.select();

if (error) throw error;
console.log(JSON.stringify(data, null, 2));
