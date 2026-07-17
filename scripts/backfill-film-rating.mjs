// One-time backfill: give films logged in-app their film-level rating/like.
//
// Two columns hold a rating and both are real (migration 0003): `watched.rating`
// is what you think of the FILM, `logs.rating` is what you thought that night.
// The Letterboxd import filled `watched`; ~500 films have only that, never having
// got a dated entry. But logFilm used to leave film-level rating/liked alone
// ("owned by the Letterboxd import"), so anything logged in the app since carried
// a diary rating and no film rating — showing "Unrated" in the All films grid and
// missing from the stats histogram, average and liked count.
//
// films.ts now maintains it going forward (syncFilmRating). This fixes the rows
// logged before that.
//
// Scope, deliberately narrow: ONLY films whose `watched.rating` is null and whose
// newest rated log has a rating. It does NOT reconcile the ~74 films that rate the
// film differently from their last log — those are real history (a later re-rate),
// and overwriting them would silently downgrade favorites like There Will Be Blood
// (film 5, last log 4). Same for `liked`, which only ever goes false -> true.
//
// Idempotent: a film with a film-level rating is already skipped by the null
// filter, so a re-run is a no-op.
//
//   node --env-file=.env scripts/backfill-film-rating.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

/** Read a whole table past PostgREST's 1000-row page cap. */
async function all(table, cols, tweak = (q) => q) {
	const out = [];
	const PAGE = 1000;
	for (let from = 0; ; from += PAGE) {
		const { data, error } = await tweak(sb.from(table).select(cols)).range(from, from + PAGE - 1);
		if (error) throw error;
		out.push(...data);
		if (data.length < PAGE) return out;
	}
}

async function main() {
	const watched = await all('watched', 'movie_id, rating, liked, movies(title)');
	const logs = await all('logs', 'movie_id, rating, liked, watched_date, id', (q) =>
		q.is('deleted_at', null),
	);

	const byMovie = new Map();
	for (const l of logs) {
		if (!byMovie.has(l.movie_id)) byMovie.set(l.movie_id, []);
		byMovie.get(l.movie_id).push(l);
	}

	const fixes = [];
	for (const w of watched) {
		const ls = byMovie.get(w.movie_id) ?? [];
		const patch = {};

		// The newest rated viewing stands as the film's rating. Undated logs sort
		// last, newest id breaks ties — same order as films.ts isNewestRatedLog.
		if (w.rating == null) {
			const newest = ls
				.filter((l) => l.rating != null)
				.sort(
					(a, b) =>
						String(b.watched_date ?? '').localeCompare(String(a.watched_date ?? '')) || b.id - a.id,
				)[0];
			if (newest) patch.rating = newest.rating;
		}
		// Liking any viewing means liking the film; never the reverse.
		if (!w.liked && ls.some((l) => l.liked)) patch.liked = true;

		if (Object.keys(patch).length > 0) {
			fixes.push({ movieId: w.movie_id, title: w.movies?.title ?? `#${w.movie_id}`, patch });
		}
	}

	console.log(`watched films:   ${watched.length}`);
	console.log(`live logs:       ${logs.length}`);
	console.log(`films to fix:    ${fixes.length}${DRY_RUN ? '  (dry run — nothing written)' : ''}\n`);
	for (const f of fixes) {
		console.log(`  ${f.title}: ${JSON.stringify(f.patch)}`);
	}
	if (DRY_RUN || fixes.length === 0) return;

	for (const f of fixes) {
		const { error } = await sb.from('watched').update(f.patch).eq('movie_id', f.movieId);
		if (error) throw new Error(`${f.title}: ${error.message}`);
	}
	console.log(`\nupdated ${fixes.length} film-level rows.`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
