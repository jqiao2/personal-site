// Relink a `movies` row the Letterboxd backfill (scripts/backfill-letterboxd.mjs)
// matched to the wrong same-title TMDB film. Its year-scoped search picks the
// wrong hit when Letterboxd and TMDB disagree on the year, or a short shares the
// title. Past fixes:
//   989 → 1339713  Obsession (Blumhouse, 2025), not an unrelated short
//   594 → 1008042  Talk to Me (Philippou, 2022), not Ribal Chedid's 2022 short
//   657 → 1140535  Presence (Soderbergh, 2024), not Ben Hutchison's PRESENCE
//
// Credits and the poster colour are cleared so their backfills re-derive them:
//   node --env-file=.env scripts/fix-tmdb-id.mjs <movies.id> <tmdb_id>
//   node --env-file=.env scripts/backfill-credits.mjs
//   node --env-file=.env scripts/backfill-poster-colors.mjs

import { createClient } from '@supabase/supabase-js';

const [MOVIE_ID, CORRECT_TMDB_ID] = process.argv.slice(2).map(Number);

if (!MOVIE_ID || !CORRECT_TMDB_ID) {
	console.error('Usage: node --env-file=.env scripts/fix-tmdb-id.mjs <movies.id> <tmdb_id>');
	process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const url = new URL(`https://api.themoviedb.org/3/movie/${CORRECT_TMDB_ID}`);

url.searchParams.set('api_key', process.env.TMDB_API_KEY);

const d = await (await fetch(url)).json();

if (!d.id) throw new Error(`TMDB has no movie ${CORRECT_TMDB_ID}`);

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
		credits_synced_at: null,
		poster_color: null,
	})
	.eq('id', MOVIE_ID)
	.select('id, tmdb_id, title, release_year');

if (error) throw error;

console.log(JSON.stringify(data));
