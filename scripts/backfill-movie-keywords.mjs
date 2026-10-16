// One-time backfill: TMDB keywords for the taste space's mood axes (migration
// 0073). syncMovieFromTmdb fills them for films cached from now on; this does
// the ones already cached.
//
// Idempotent: only rows with no keywords are fetched, so a re-run picks up just
// what failed or arrived since. A film TMDB has no keywords for stores [].
//
//   node --env-file=.env scripts/backfill-movie-keywords.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const rows = [];

for (let from = 0; ; from += 1000) {
	const { data, error } = await sb
		.from('movies')
		.select('id, tmdb_id, title')
		.is('keywords', null)
		.order('id')
		.range(from, from + 999);

	if (error) throw error;

	rows.push(...data);

	if (data.length < 1000) break;
}

console.log(`${rows.length} films to fetch${DRY_RUN ? ' (dry run)' : ''}`);

let done = 0;

let failed = 0;

// TMDB allows ~40 req/s; 8 at a time stays well under.
const CONCURRENCY = 8;

for (let i = 0; i < rows.length; i += CONCURRENCY) {
	await Promise.all(
		rows.slice(i, i + CONCURRENCY).map(async (m) => {
			const res = await fetch(
				`https://api.themoviedb.org/3/movie/${m.tmdb_id}/keywords?api_key=${process.env.TMDB_API_KEY}`,
			);

			if (!res.ok) {
				failed++;
				console.warn(`  ${res.status}: ${m.id} ${m.title}`);

				return;
			}

			const keywords = (await res.json()).keywords.map((k) => k.name);

			if (!DRY_RUN) {
				const { error } = await sb.from('movies').update({ keywords }).eq('id', m.id);

				if (error) throw error;
			}

			done++;
		}),
	);
}

console.log(`${done} fetched, ${failed} failed`);
