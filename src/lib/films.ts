// Service layer that sits between the API routes and Supabase/TMDB.
// Endpoints stay thin; the "check cache → maybe fetch TMDB → write" logic lives
// here so it's written once.
import { supabaseAdmin, supabasePublic } from './supabase';
import { getMovieDetails, releaseYear } from './tmdb';

/** How long a cached movie row is considered fresh before we re-sync from TMDB. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface MovieRow {
	id: number;
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	backdrop_path: string | null;
	overview: string | null;
	runtime: number | null;
	last_synced_at: string;
}

/** Fetch fresh details from TMDB and upsert the lightweight cache row. */
async function syncMovieFromTmdb(tmdbId: number): Promise<MovieRow> {
	const d = await getMovieDetails(tmdbId);
	const { data, error } = await supabaseAdmin
		.from('movies')
		.upsert(
			{
				tmdb_id: d.id,
				title: d.title,
				release_year: releaseYear(d.release_date),
				poster_path: d.poster_path,
				backdrop_path: d.backdrop_path,
				overview: d.overview,
				runtime: d.runtime,
				last_synced_at: new Date().toISOString(),
			},
			{ onConflict: 'tmdb_id' },
		)
		.select()
		.single();
	if (error) throw new Error(`upsert movie ${tmdbId} failed: ${error.message}`);
	return data as MovieRow;
}

/**
 * Return the local movie row for a TMDB id, fetching+caching it on a miss and
 * refreshing it in the background if the cache is older than STALE_AFTER_MS.
 * `forceRefresh` skips the freshness check.
 */
export async function ensureMovieCached(tmdbId: number, forceRefresh = false): Promise<MovieRow> {
	const { data: existing, error } = await supabaseAdmin
		.from('movies')
		.select('*')
		.eq('tmdb_id', tmdbId)
		.maybeSingle();
	if (error) throw new Error(`lookup movie ${tmdbId} failed: ${error.message}`);

	if (existing) {
		const age = Date.now() - new Date(existing.last_synced_at).getTime();
		if (!forceRefresh && age < STALE_AFTER_MS) return existing as MovieRow;
		// Stale: refresh, but don't fail the whole request if TMDB is momentarily down.
		try {
			return await syncMovieFromTmdb(tmdbId);
		} catch {
			return existing as MovieRow;
		}
	}
	return syncMovieFromTmdb(tmdbId);
}

export interface CreateLogInput {
	tmdbId: number;
	watchedDate?: string | null; // "YYYY-MM-DD"
	rating?: number | null; // 0.5–5.0 in half-steps
	reviewText?: string | null;
	rewatched?: boolean;
	liked?: boolean;
	tags?: string[];
}

/** Upsert the film-level "watched" record (mark the movie seen). Decision A: does
 * NOT touch film-level rating/liked — those are owned by the Letterboxd import.
 * Idempotent via the movie_id unique constraint: re-logging keeps the original
 * first_watched. */
async function markWatched(movie: MovieRow, watchedDate: string | null): Promise<void> {
	const firstWatched = watchedDate ? `${watchedDate}T00:00:00Z` : new Date().toISOString();
	const { error } = await supabaseAdmin.from('watched').upsert(
		{
			movie_id: movie.id,
			first_watched: firstWatched,
			tmdb_url: `https://www.themoviedb.org/movie/${movie.tmdb_id}`,
		},
		{ onConflict: 'movie_id', ignoreDuplicates: true },
	);
	if (error) throw new Error(`mark watched failed: ${error.message}`);
}

/** Remove a movie from the watchlist. Idempotent no-op when it isn't on the list;
 * logging/watching a film drops it here so "watched" and "to watch" stay disjoint. */
async function removeFromWatchlist(movieId: number): Promise<void> {
	const { error } = await supabaseAdmin.from('watchlist').delete().eq('movie_id', movieId);
	if (error) throw new Error(`remove from watchlist failed: ${error.message}`);
}

/** Whether an entry carries anything beyond "I saw it" — i.e. worth a diary row. */
function hasDiaryContent(input: CreateLogInput): boolean {
	return (
		input.rating != null ||
		input.liked === true ||
		input.rewatched === true ||
		(typeof input.reviewText === 'string' && input.reviewText.trim().length > 0) ||
		(Array.isArray(input.tags) && input.tags.some((t) => t.trim().length > 0))
	);
}

export interface LogFilmResult {
	movieId: number;
	watchedOnly: boolean; // true = only marked watched, no diary log created
	logId: number | null;
}

/**
 * Record watching a film. Always marks it watched (film-level). If the entry has
 * any content (rating / like / rewatch / review / tags) it also creates a dated
 * diary log; a bare movie-only submission creates no log row.
 */
export async function logFilm(input: CreateLogInput): Promise<LogFilmResult> {
	const movie = await ensureMovieCached(input.tmdbId);
	await markWatched(movie, input.watchedDate ?? null);
	// Once it's watched it no longer belongs on the "to watch" list.
	await removeFromWatchlist(movie.id);

	if (!hasDiaryContent(input)) {
		return { movieId: movie.id, watchedOnly: true, logId: null };
	}

	const today = new Date().toISOString().slice(0, 10);
	const { data: log, error } = await supabaseAdmin
		.from('logs')
		.insert({
			movie_id: movie.id,
			watched_date: input.watchedDate ?? null,
			log: today, // diary date — when the entry was made
			rating: input.rating ?? null,
			review_text: input.reviewText ?? null,
			rewatched: input.rewatched ?? false,
			liked: input.liked ?? false,
		})
		.select('id')
		.single();
	if (error) throw new Error(`insert log failed: ${error.message}`);

	const tags = normalizeTags(input.tags);
	if (tags.length > 0) await attachTags(log.id, tags);

	return { movieId: movie.id, watchedOnly: false, logId: log.id as number };
}

function normalizeTags(tags: string[] | undefined): string[] {
	if (!tags) return [];
	const seen = new Set<string>();
	for (const raw of tags) {
		const name = raw.trim().toLowerCase();
		if (name) seen.add(name);
	}
	return [...seen];
}

/** Upsert tag names and link them to a log. */
async function attachTags(logId: number, names: string[]): Promise<void> {
	const { data: tagRows, error: tagErr } = await supabaseAdmin
		.from('tags')
		.upsert(
			names.map((name) => ({ name })),
			{ onConflict: 'name' },
		)
		.select('id');
	if (tagErr) throw new Error(`upsert tags failed: ${tagErr.message}`);

	const links = (tagRows as { id: number }[]).map((t) => ({ log_id: logId, tag_id: t.id }));
	const { error: linkErr } = await supabaseAdmin.from('log_tags').insert(links);
	if (linkErr) throw new Error(`link tags failed: ${linkErr.message}`);
}

// --- Reads (public, via anon key + RLS public-read policies) ---

/** A watch as shown in the diary list — movie fields flattened, tags collapsed. */
export interface LogListItem {
	id: number;
	watched_date: string | null;
	rating: number | null;
	review_text: string | null;
	rewatched: boolean;
	liked: boolean;
	created_at: string;
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	tags: string[];
}

/** A single watch with the full cached movie row, for the detail page. */
export interface LogDetail {
	id: number;
	watched_date: string | null;
	rating: number | null;
	review_text: string | null;
	rewatched: boolean;
	liked: boolean;
	created_at: string;
	movie: {
		id: number;
		tmdb_id: number;
		title: string;
		release_year: number | null;
		poster_path: string | null;
		backdrop_path: string | null;
		overview: string | null;
		runtime: number | null;
	};
	tags: string[];
}

/** A diary log for one movie, as shown in the film page's "Your reviews" list. */
export interface MovieLog {
	id: number;
	watched_date: string | null;
	rating: number | null;
	review_text: string | null;
	rewatched: boolean;
	liked: boolean;
	created_at: string;
}

/**
 * Logged watches, newest first. The logs_with_movie view already excludes
 * soft-deleted rows (migration 0005) and aggregates tags, so this is a plain
 * select.
 */
export async function listLogs(limit = 1000, offset = 0): Promise<LogListItem[]> {
	const { data, error } = await supabasePublic
		.from('logs_with_movie')
		.select(
			'id, watched_date, rating, review_text, rewatched, liked, created_at, ' +
				'tmdb_id, title, release_year, poster_path, tags',
		)
		.order('watched_date', { ascending: false, nullsFirst: false })
		.order('created_at', { ascending: false })
		.range(offset, offset + limit - 1);
	if (error) throw new Error(`listLogs failed: ${error.message}`);
	return (data ?? []) as unknown as LogListItem[];
}

/** One watch by id, with its movie and tags. Null if it doesn't exist. */
export async function getLogById(id: number): Promise<LogDetail | null> {
	const { data, error } = await supabasePublic
		.from('logs')
		.select(
			'id, watched_date, rating, review_text, rewatched, liked, created_at, ' +
				'movies(id, tmdb_id, title, release_year, poster_path, backdrop_path, overview, runtime), ' +
				'log_tags(tags(name))',
		)
		.eq('id', id)
		.is('deleted_at', null)
		.maybeSingle();
	if (error) throw new Error(`getLogById failed: ${error.message}`);
	if (!data) return null;

	const row = data as unknown as {
		id: number;
		watched_date: string | null;
		rating: number | null;
		review_text: string | null;
		rewatched: boolean;
		liked: boolean;
		created_at: string;
		movies: LogDetail['movie'];
		log_tags: { tags: { name: string } }[];
	};
	return {
		id: row.id,
		watched_date: row.watched_date,
		rating: row.rating,
		review_text: row.review_text,
		rewatched: row.rewatched,
		liked: row.liked,
		created_at: row.created_at,
		movie: row.movies,
		tags: (row.log_tags ?? []).map((lt) => lt.tags.name).sort(),
	};
}

/**
 * Every diary log for one movie (by internal movie id), newest first. Powers the
 * "Your reviews" list on a film page. Soft-deleted rows are excluded.
 */
export async function listLogsByMovie(movieId: number): Promise<MovieLog[]> {
	const { data, error } = await supabasePublic
		.from('logs')
		.select('id, watched_date, rating, review_text, rewatched, liked, created_at')
		.eq('movie_id', movieId)
		.is('deleted_at', null)
		.order('watched_date', { ascending: false, nullsFirst: false })
		.order('created_at', { ascending: false });
	if (error) throw new Error(`listLogsByMovie failed: ${error.message}`);
	return (data ?? []) as MovieLog[];
}

// --- Aggregates for the film-log overview ("Jason's film log") ---

/** Sidebar counts + this-year total + the all-time ratings histogram. */
export interface FilmLogStats {
	/** distinct films marked watched */
	watched: number;
	/** live diary entries */
	diary: number;
	watchlist: number;
	/** films liked (film-level) */
	liked: number;
	/** films first watched in the current calendar year */
	thisYear: number;
	/** 10 buckets, index 0 = ½★ … index 9 = 5★ */
	histogram: number[];
	ratedTotal: number;
	ratedAvg: string;
}

export async function getFilmLogStats(): Promise<FilmLogStats> {
	const year = new Date().getFullYear();
	const head = { count: 'exact' as const, head: true };
	const [watched, diary, watchlist, liked, thisYear, ratings] = await Promise.all([
		supabasePublic.from('watched').select('*', head),
		supabasePublic.from('logs_with_movie').select('*', head),
		supabasePublic.from('watchlist').select('*', head),
		supabasePublic.from('watched').select('*', head).eq('liked', true),
		supabasePublic.from('watched').select('*', head).gte('first_watched', `${year}-01-01`),
		supabasePublic.from('watched').select('rating').not('rating', 'is', null),
	]);

	const histogram = new Array(10).fill(0);
	let ratedTotal = 0;
	let weighted = 0;
	for (const row of (ratings.data ?? []) as { rating: number }[]) {
		const idx = Math.round(row.rating * 2) - 1; // 0.5→0 … 5.0→9
		if (idx >= 0 && idx < 10) {
			histogram[idx]++;
			ratedTotal++;
			weighted += row.rating;
		}
	}

	return {
		watched: watched.count ?? 0,
		diary: diary.count ?? 0,
		watchlist: watchlist.count ?? 0,
		liked: liked.count ?? 0,
		thisYear: thisYear.count ?? 0,
		histogram,
		ratedTotal,
		ratedAvg: ratedTotal ? (weighted / ratedTotal).toFixed(1) : '—',
	};
}

/** A poster tile on the overview (favorites / recent diary). */
export interface FilmTile {
	logId: number | null;
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	rating: number | null;
	watched_date: string | null;
}

/**
 * "Favorite films" — there's no favorites table, so we derive them from your
 * five-star liked diary entries (most recent first, one tile per film).
 */
export async function listFavorites(limit = 4): Promise<FilmTile[]> {
	const { data, error } = await supabasePublic
		.from('logs_with_movie')
		.select('id, tmdb_id, title, release_year, poster_path, rating, watched_date')
		.eq('liked', true)
		.eq('rating', 5)
		.order('watched_date', { ascending: false, nullsFirst: false })
		.limit(limit * 6);
	if (error) throw new Error(`listFavorites failed: ${error.message}`);

	const seen = new Set<number>();
	const out: FilmTile[] = [];
	for (const r of (data ?? []) as Record<string, unknown>[]) {
		const tmdbId = r.tmdb_id as number;
		if (seen.has(tmdbId)) continue;
		seen.add(tmdbId);
		out.push({
			logId: r.id as number,
			tmdb_id: tmdbId,
			title: r.title as string,
			release_year: r.release_year as number | null,
			poster_path: r.poster_path as string | null,
			rating: r.rating as number | null,
			watched_date: r.watched_date as string | null,
		});
		if (out.length >= limit) break;
	}
	return out;
}

/** A watchlist poster tile on the overview. */
export interface WatchlistTile {
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
}

/** Most recently added watchlist films. */
export async function listWatchlist(limit = 4): Promise<WatchlistTile[]> {
	const { data, error } = await supabasePublic
		.from('watchlist')
		.select('added_at, movies(tmdb_id, title, release_year, poster_path)')
		.order('added_at', { ascending: false })
		.limit(limit);
	if (error) throw new Error(`listWatchlist failed: ${error.message}`);
	return ((data ?? []) as unknown as { movies: WatchlistTile }[]).map((r) => r.movies);
}

/** A full watchlist entry for the watchlist page — tile fields plus when it was added. */
export interface WatchlistEntry extends WatchlistTile {
	added_at: string;
}

/** The entire watchlist, most recently added first — powers /films/watchlist. */
export async function listAllWatchlist(): Promise<WatchlistEntry[]> {
	const { data, error } = await supabasePublic
		.from('watchlist')
		.select('added_at, movies(tmdb_id, title, release_year, poster_path)')
		.order('added_at', { ascending: false });
	if (error) throw new Error(`listAllWatchlist failed: ${error.message}`);
	return ((data ?? []) as unknown as { added_at: string; movies: WatchlistTile }[]).map((r) => ({
		...r.movies,
		added_at: r.added_at,
	}));
}
