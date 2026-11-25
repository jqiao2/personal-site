// Keep the site's `watchlist` in step with the Letterboxd watchlist. Two callers,
// as with the recipes sync: the daily Vercel cron and the owner, both through
// /api/films/watchlist/letterboxd-sync.
//
// Letterboxd is read, never written: films added there appear here, films it drops
// leave here, and films added on the site alone stay. See planWatchlistSync().
import { supabaseAdmin } from './supabase';
import { ensureMovieCached } from './films';
import {
	LETTERBOXD_USER,
	fetchFilmTmdbId,
	fetchWatchlistSlugs,
	planWatchlistSync,
	type WatchlistEntry,
} from './letterboxd';

/** Film pages read per run. A new film costs one page; the slug→TMDB table
 *  remembers it after that, so a normal day reads none or one. A backlog bigger
 *  than this finishes over the next runs. */
const LOOKUPS_PER_RUN = 120;

/** A run that would take more than this many films off the site does nothing
 *  instead and says so: that is a broken page or a changed markup far more often
 *  than a real cull. Run it as the owner with `?force=1` to let it through. */
const MAX_REMOVALS = 25;

/** `.in()` lists go in the URL, so long ones are split. */
const CHUNK = 150;

export interface LetterboxdSyncResult {
	onLetterboxd: number;
	added: number;
	claimed: number;
	removed: number;
	/** Films on Letterboxd with no TMDB movie (miniseries), or still to be looked up. */
	unresolved: string[];
	/** Films that could not be added this run, by TMDB id, with the reason. */
	failed: { tmdbId: number; error: string }[];
	/** Why removals were held back, when they were. */
	removalsHeld: string | null;
}

function chunks<T>(items: T[]): T[][] {
	const out: T[][] = [];

	for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));

	return out;
}

/** Run `work` over `items`, four at a time — polite to Letterboxd and TMDB. */
async function eachLimited<T>(items: T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;

	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;

			await work(items[i], i);
		}
	};

	await Promise.all([worker(), worker(), worker(), worker()]);
}

/** Slug → TMDB id for every slug, from `letterboxd_films`, reading the film page
 *  of any slug not seen before. Returns the map and the slugs left unknown. */
async function resolveSlugs(slugs: string[]): Promise<{ ids: Map<string, number | null>; pending: string[] }> {
	const ids = new Map<string, number | null>();

	for (const part of chunks(slugs)) {
		const { data, error } = await supabaseAdmin.from('letterboxd_films').select('slug, tmdb_id').in('slug', part);

		if (error) throw new Error(`letterboxd_films lookup failed: ${error.message}`);

		for (const row of data) ids.set(row.slug, row.tmdb_id);
	}

	const unseen = slugs.filter((s) => !ids.has(s));

	const found: { slug: string; tmdb_id: number | null }[] = [];

	await eachLimited(unseen.slice(0, LOOKUPS_PER_RUN), async (slug) => {
		try {
			const tmdbId = await fetchFilmTmdbId(slug);

			ids.set(slug, tmdbId);

			found.push({ slug, tmdb_id: tmdbId });
		} catch {
			// Left pending; the next run tries again.
		}
	});

	if (found.length) {
		const { error } = await supabaseAdmin.from('letterboxd_films').upsert(found);

		if (error) throw new Error(`letterboxd_films save failed: ${error.message}`);
	}

	return { ids, pending: slugs.filter((s) => !ids.has(s)) };
}

/** The TMDB id off an embedded `movies(tmdb_id)`. PostgREST sends a many-to-one
 *  embed as one object; the untyped client calls it an array. Take either. */
function tmdbOf(movies: { tmdb_id: number } | { tmdb_id: number }[]): number {
	return Array.isArray(movies) ? movies[0].tmdb_id : movies.tmdb_id;
}

async function watchlistRows(): Promise<WatchlistEntry[]> {
	const rows: WatchlistEntry[] = [];

	// PostgREST stops at 1000 rows, so page through.
	for (let from = 0; ; from += 1000) {
		const { data, error } = await supabaseAdmin
			.from('watchlist')
			.select('movie_id, from_letterboxd, movies!inner(tmdb_id)')
			.order('id')
			.range(from, from + 999);

		if (error) throw new Error(`watchlist read failed: ${error.message}`);

		for (const r of data) {
			rows.push({ movieId: r.movie_id, tmdbId: tmdbOf(r.movies), fromLetterboxd: r.from_letterboxd });
		}

		if (data.length < 1000) return rows;
	}
}

/** Which of these TMDB ids are films already watched. */
async function watchedAmong(tmdbIds: number[]): Promise<Set<number>> {
	const watched = new Set<number>();

	for (const part of chunks(tmdbIds)) {
		const { data, error } = await supabaseAdmin
			.from('watched')
			.select('movies!inner(tmdb_id)')
			.in('movies.tmdb_id', part);

		if (error) throw new Error(`watched lookup failed: ${error.message}`);

		for (const r of data) watched.add(tmdbOf(r.movies));
	}

	return watched;
}

export async function syncLetterboxdWatchlist(force: boolean): Promise<LetterboxdSyncResult> {
	const slugs = await fetchWatchlistSlugs(LETTERBOXD_USER);

	// An empty watchlist reads the same as a page Letterboxd failed to render.
	// Refuse it rather than empty the site's list.
	if (!slugs.length) throw new Error('letterboxd watchlist came back empty');

	const { ids, pending } = await resolveSlugs(slugs);

	const tmdbIds: number[] = [];

	const unresolved = [...pending];

	for (const slug of slugs) {
		const id = ids.get(slug);

		if (id) tmdbIds.push(id);
		else if (id === null) unresolved.push(slug);
	}

	const plan = planWatchlistSync(tmdbIds, await watchlistRows(), await watchedAmong(tmdbIds));

	// Newest on Letterboxd first: space the timestamps a second apart, so the
	// site's newest-first order matches Letterboxd's within one run.
	const now = Date.now();

	const failed: LetterboxdSyncResult['failed'] = [];

	let added = 0;

	await eachLimited(plan.add, async (tmdbId, i) => {
		try {
			const movie = await ensureMovieCached(tmdbId);

			const { error } = await supabaseAdmin
				.from('watchlist')
				.upsert(
					{ movie_id: movie.id, added_at: new Date(now - i * 1000).toISOString(), from_letterboxd: true },
					{ onConflict: 'movie_id', ignoreDuplicates: true },
				);

			if (error) throw new Error(error.message);

			added++;
		} catch (e) {
			failed.push({ tmdbId, error: e instanceof Error ? e.message : String(e) });
		}
	});

	for (const part of chunks(plan.claim)) {
		const { error } = await supabaseAdmin.from('watchlist').update({ from_letterboxd: true }).in('movie_id', part);

		if (error) throw new Error(`watchlist claim failed: ${error.message}`);
	}

	let removalsHeld: string | null = null;

	if (pending.length) {
		// A film not yet looked up might be one of the rows about to go.
		removalsHeld = `${pending.length} films still to look up`;
	} else if (plan.remove.length > MAX_REMOVALS && !force) {
		removalsHeld = `${plan.remove.length} removals is more than ${MAX_REMOVALS}; rerun with force to apply`;
	}

	let removed = 0;

	if (!removalsHeld) {
		for (const part of chunks(plan.remove)) {
			const { error } = await supabaseAdmin.from('watchlist').delete().in('movie_id', part);

			if (error) throw new Error(`watchlist removal failed: ${error.message}`);
		}

		removed = plan.remove.length;
	}

	return {
		onLetterboxd: slugs.length,
		added,
		claimed: plan.claim.length,
		removed,
		unresolved,
		failed,
		removalsHeld,
	};
}
