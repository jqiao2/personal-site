import { supabasePublic } from './supabase';
import { siteDay } from './day';
import { isMatchMode, pgTextArray, type MatchMode, type WatchlistEntry } from './films';

/** Sort orders the watchlist grid offers. */
export type WatchlistSort = 'added' | 'year' | 'shuffle';

/** Which slice of the watchlist to read — the Watchlist page's filters, server-side. */
export interface WatchlistQuery {
	/** Case-insensitive title substring; '' matches everything. */
	q?: string;
	sort?: WatchlistSort;
	/** Shuffle's deal. The same seed always gives the same order, so paging through a
	 * shuffle doesn't repeat or skip films. Ignored by the other sorts. */
	seed?: number;
	limit?: number;
	offset?: number;
	/** Inclusive release-year bounds. A film with no release year falls outside any
	 * bound, so a narrowed range drops it. Omit both for "any year". */
	releaseYearMin?: number;
	releaseYearMax?: number;
	/** False drops films whose release date is still ahead of us. */
	includeUpcoming?: boolean;
	genres?: string[];
	/** Genre alone has an any/all toggle; every other group is "any of". */
	genreMode?: MatchMode;
	languages?: string[];
	directors?: string[];
	actors?: string[];
}

export interface WatchlistPage {
	films: WatchlistEntry[];
	/** Films matching the query across every page — not just the ones returned here. */
	total: number;
}

export function isWatchlistSort(v: unknown): v is WatchlistSort {
	return v === 'added' || v === 'year' || v === 'shuffle';
}

/**
 * The Watchlist filter state, read out of a query string. /films/watchlist and
 * /api/films/watchlist/list both parse through here, so the server-rendered first
 * page and the batches paged in afterwards can't read a link differently.
 * Anything unrecognized falls back to "don't filter by this".
 */
export function watchlistQueryFromParams(p: URLSearchParams): WatchlistQuery {
	const sort = p.get('sort');
	const genreMode = p.get('genremode');
	const seed = Number.parseInt(p.get('seed') ?? '', 10);

	return {
		q: p.get('q')?.trim() ?? '',
		sort: isWatchlistSort(sort) ? sort : 'added',
		seed: Number.isFinite(seed) ? seed : undefined,
		releaseYearMin: yearBound(p.get('dmin')),
		releaseYearMax: yearBound(p.get('dmax')),
		includeUpcoming: p.get('upcoming') !== '0',
		genres: p.getAll('genre'),
		genreMode: isMatchMode(genreMode) ? genreMode : 'any',
		languages: p.getAll('language'),
		directors: p.getAll('director'),
		actors: p.getAll('actor'),
	};
}

/** How many filters are on — the Filters button's badge. The search term and sort
 * aren't filters; the release range counts once however many years it spans. */
export function watchlistFilterCount(q: WatchlistQuery): number {
	return (
		(q.releaseYearMin != null || q.releaseYearMax != null ? 1 : 0) +
		(q.includeUpcoming === false ? 1 : 0) +
		(q.genres?.length ?? 0) +
		(q.languages?.length ?? 0) +
		(q.directors?.length ?? 0) +
		(q.actors?.length ?? 0)
	);
}

function yearBound(raw: string | null): number | undefined {
	const n = Number.parseInt(raw ?? '', 10);

	return Number.isFinite(n) ? n : undefined;
}

/**
 * The shuffle order's key: a cheap deterministic hash of the title under a seed,
 * so a shuffle holds still while you page and filter, and each press of Shuffle
 * deals a different order.
 */
function shuffleRank(title: string, seed: number): number {
	let h = seed;

	for (const ch of title.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 100000;

	return h;
}

const TILE_SELECT =
	'id, added_at, movies!inner(tmdb_id, title, release_year, release_date, premiere_date, poster_path)';

type Row = {
	id: number;
	added_at: string;
	movies: Omit<WatchlistEntry, 'added_at'>;
};

const toEntry = (r: Row): WatchlistEntry => ({ ...r.movies, added_at: r.added_at });

/**
 * One page of the watchlist grid, filtered and sorted server-side so paging covers
 * the whole list rather than what's loaded — the same shape as listWatchedPage.
 *
 * "Recently added" and "Release date" page in the database. Shuffle can't — there's
 * no seeded order PostgREST can express — so it reads every matching film's tile
 * (a few hundred narrow rows at most), deals them here and slices the page out.
 */
export async function listWatchlistPage(query: WatchlistQuery = {}): Promise<WatchlistPage> {
	const { q = '', sort = 'added', limit = 100, offset = 0 } = query;

	// `!inner` on the movie embed is what lets a filter on it drop the parent row.
	let req = supabasePublic.from('watchlist').select(TILE_SELECT, { count: 'exact' });

	const term = q.trim();

	// Escape the LIKE wildcards so a literal % or _ in a title search stays literal.
	if (term) req = req.ilike('movies.title', `%${term.replace(/[%_]/g, '\\$&')}%`);

	// A null release_year fails either comparison, which is what drops the undated.
	if (query.releaseYearMin != null) req = req.gte('movies.release_year', query.releaseYearMin);

	if (query.releaseYearMax != null) req = req.lte('movies.release_year', query.releaseYearMax);

	// Upcoming means a release date still ahead of us. Films with no date at all
	// aren't upcoming — unknown isn't the same as future — so they stay.
	if (query.includeUpcoming === false) {
		req = req.or(`release_date.is.null,release_date.lte.${siteDay()}`, { referencedTable: 'movies' });
	}

	// Genre "all" needs every picked genre (`cs`, contains); "any" needs one (`ov`).
	if (query.genres?.length) {
		req = req.filter('movies.genres', query.genreMode === 'all' ? 'cs' : 'ov', pgTextArray(query.genres));
	}

	if (query.languages?.length) req = req.in('movies.original_language', query.languages);

	if (query.directors?.length) req = req.filter('movies.directors', 'ov', pgTextArray(query.directors));

	if (query.actors?.length) req = req.filter('movies.actors', 'ov', pgTextArray(query.actors));

	if (sort === 'shuffle') {
		const { data, error, count } = await req.order('added_at', { ascending: false });

		if (error) throw new Error(`listWatchlistPage failed: ${error.message}`);
		const seed = query.seed ?? 1;

		// Array.sort is stable, so equal ranks keep their added order.
		const dealt = ((data ?? []) as unknown as Row[])
			.map((r) => ({ r, rank: shuffleRank(r.movies.title, seed) }))
			.sort((a, b) => a.rank - b.rank);

		return { films: dealt.slice(offset, offset + limit).map(({ r }) => toEntry(r)), total: count ?? dealt.length };
	}

	// "Release date" is newest first by the full premiere date (earliest release
	// anywhere), so two films from the same year keep their real order; films with
	// only a year follow the dated ones, and films with neither go last. Ties keep the
	// added order below. movies(col) orders the parent rows by the joined column —
	// `referencedTable` would only sort within each embed, a no-op for a to-one join.
	if (sort === 'year') {
		req = req
			.order('movies(premiere_date)', { ascending: false, nullsFirst: false })
			.order('movies(release_year)', { ascending: false, nullsFirst: false });
	}

	const { data, error, count } = await req
		.order('added_at', { ascending: false })
		.order('id', { ascending: false })
		.range(offset, offset + limit - 1);

	if (error) throw new Error(`listWatchlistPage failed: ${error.message}`);

	return { films: ((data ?? []) as unknown as Row[]).map(toEntry), total: count ?? 0 };
}

/** Collection-wide facts the page's header and filter panel need, independent of
 * whatever filters are on: the count, the release-year span the slider runs over,
 * and whether "Include upcoming" has anything to exclude. */
export interface WatchlistSummary {
	total: number;
	relLo: number | null;
	relHi: number | null;
	hasUpcoming: boolean;
}

/** Two scalar columns per film — a few KB for the whole list, and never shipped. */
export async function getWatchlistSummary(): Promise<WatchlistSummary> {
	const { data, error } = await supabasePublic.from('watchlist').select('movies(release_year, release_date)');

	if (error) throw new Error(`getWatchlistSummary failed: ${error.message}`);
	const rows = (data ?? []) as unknown as { movies: { release_year: number | null; release_date: string | null } }[];
	const today = siteDay();
	let relLo: number | null = null;
	let relHi: number | null = null;
	let hasUpcoming = false;

	for (const { movies: m } of rows) {
		if (m.release_year != null) {
			relLo = relLo == null ? m.release_year : Math.min(relLo, m.release_year);
			relHi = relHi == null ? m.release_year : Math.max(relHi, m.release_year);
		}

		if (m.release_date != null && m.release_date > today) hasUpcoming = true;
	}

	return { total: rows.length, relLo, relHi, hasUpcoming };
}
