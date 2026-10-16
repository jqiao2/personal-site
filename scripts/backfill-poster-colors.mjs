// One-time backfill: the dominant poster colour the closet prints each spine in
// (migration 0072). syncMovieFromTmdb fills it for films cached from now on;
// this does the ones already cached.
//
// Idempotent: only rows with a poster and no colour are read, so a re-run picks
// up just what failed or arrived since.
//
//   node --env-file=.env scripts/backfill-poster-colors.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js';
import { posterColor } from '../src/lib/poster-color.ts';

const DRY_RUN = process.argv.includes('--dry-run');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const rows = [];

for (let from = 0; ; from += 1000) {
	const { data, error } = await sb
		.from('movies')
		.select('id, title, poster_path')
		.not('poster_path', 'is', null)
		.is('poster_color', null)
		.order('id')
		.range(from, from + 999);

	if (error) throw error;

	rows.push(...data);

	if (data.length < 1000) break;
}

console.log(`${rows.length} posters to read${DRY_RUN ? ' (dry run)' : ''}`);

let done = 0;

let failed = 0;

// A few at a time: TMDB's image CDN is fine with it, and 1,600 in series is slow.
const CONCURRENCY = 8;

for (let i = 0; i < rows.length; i += CONCURRENCY) {
	await Promise.all(
		rows.slice(i, i + CONCURRENCY).map(async (m) => {
			const color = await posterColor(m.poster_path);

			if (!color) {
				failed++;
				console.warn(`  no colour: ${m.id} ${m.title}`);

				return;
			}

			if (!DRY_RUN) {
				const { error } = await sb.from('movies').update({ poster_color: color }).eq('id', m.id);

				if (error) throw error;
			}

			done++;
		}),
	);
}

console.log(`${done} coloured, ${failed} without a colour`);
