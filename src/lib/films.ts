// Service layer that sits between the API routes and Supabase/TMDB.
// Endpoints stay thin; the "check cache → maybe fetch TMDB → write" logic lives
// here so it's written once.
import { supabaseAdmin, supabasePublic } from './supabase';
import { extractCreditFacts, getMovieDetails, releaseYear } from './tmdb';

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

/**
 * Whether a PostgREST error is "this column doesn't exist yet" — i.e. migration
 * 0008 (the genre/credit columns) hasn't been applied. Lets the movie cache and
 * Stats read degrade gracefully instead of hard-failing before the migration.
 */
function isMissingCreditColumn(err: { code?: string; message?: string } | null): boolean {
	if (!err) return false;
	const msg = (err.message ?? '').toLowerCase();
	return (
		err.code === '42703' || // undefined_column
		err.code === 'PGRST204' || // column not found in schema cache
		(msg.includes('column') && msg.includes('does not exist')) ||
		msg.includes('schema cache')
	);
}

/** Fetch fresh details from TMDB and upsert the lightweight cache row. */
async function syncMovieFromTmdb(tmdbId: number): Promise<MovieRow> {
	const d = await getMovieDetails(tmdbId);
	const facts = extractCreditFacts(d);
	const now = new Date().toISOString();
	const base = {
		tmdb_id: d.id,
		title: d.title,
		release_year: releaseYear(d.release_date),
		poster_path: d.poster_path,
		backdrop_path: d.backdrop_path,
		overview: d.overview,
		runtime: d.runtime,
		last_synced_at: now,
	};
	// Genre + credit facts for the Stats page (migration 0008). The backfill fills
	// these in bulk for existing films; this keeps them fresh for anything logged
	// from now on. If 0008 hasn't been applied yet, fall back to the base columns
	// so caching a movie still works.
	const withFacts = {
		...base,
		genres: facts.genres,
		languages: facts.languages,
		countries: facts.countries,
		directors: facts.directors,
		actors: facts.actors,
		original_language: facts.originalLanguage,
		mpa_rating: facts.mpaRating,
		credits_synced_at: now,
	};
	const upsert = (payload: typeof base | typeof withFacts) =>
		supabaseAdmin.from('movies').upsert(payload, { onConflict: 'tmdb_id' }).select().single();

	let { data, error } = await upsert(withFacts);
	if (error && isMissingCreditColumn(error)) {
		({ data, error } = await upsert(base));
	}
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

/**
 * Prior-watch summary for a TMDB id, used by the diary composer to auto-suggest
 * a rewatch and pre-fill the previous rating/like when logging a film you've
 * already seen. `watched` is true when there's any diary log OR a film-level
 * `watched` row (imported films that never got a dated diary entry). The rating
 * and liked values come from the most recent diary log, falling back to the
 * film-level row. Returns the not-watched default for films not in the cache.
 */
export interface PriorWatch {
	watched: boolean;
	logCount: number;
	rating: number | null;
	liked: boolean;
}

export async function getPriorWatch(tmdbId: number): Promise<PriorWatch> {
	const NONE: PriorWatch = { watched: false, logCount: 0, rating: null, liked: false };

	const { data: movie, error } = await supabasePublic
		.from('movies')
		.select('id, watched(rating, liked, first_watched)')
		.eq('tmdb_id', tmdbId)
		.maybeSingle();
	if (error) throw new Error(`getPriorWatch failed: ${error.message}`);
	if (!movie) return NONE;

	const row = movie as unknown as {
		id: number;
		watched: WatchedActivity[] | WatchedActivity | null;
	};
	const filmWatched = Array.isArray(row.watched) ? (row.watched[0] ?? null) : (row.watched ?? null);
	const logs = await listLogsByMovie(row.id);
	const mostRecent = logs[0] ?? null;

	if (logs.length === 0 && !filmWatched) return NONE;
	return {
		watched: true,
		logCount: logs.length,
		rating: mostRecent?.rating ?? filmWatched?.rating ?? null,
		liked: mostRecent?.liked ?? filmWatched?.liked ?? false,
	};
}

/** Film-level "watched" facts (owned by the Letterboxd import), for a film page. */
export interface WatchedActivity {
	rating: number | null;
	liked: boolean;
	first_watched: string;
}

/** A film page keyed by TMDB id: the cached movie plus its film-level watched row. */
export interface FilmByTmdb {
	movie: {
		id: number;
		tmdb_id: number;
		title: string;
		release_year: number | null;
		poster_path: string | null;
		backdrop_path: string | null;
		overview: string | null;
		runtime: number | null;
		/** Genre + credit facts cached from TMDB (migration 0008); [] until backfilled. */
		genres: string[];
		directors: string[];
		actors: string[];
		countries: string[];
		/** Original language as an English name (migration 0009); null until backfilled. */
		original_language: string | null;
		/** US content rating, e.g. "PG-13" (migration 0009); null when none. */
		mpa_rating: string | null;
	};
	/** Null when the film is cached but not (yet) marked watched. */
	watched: WatchedActivity | null;
}

/**
 * One film by TMDB id, with its film-level watched row (rating / liked / first
 * watched) and the cached genre/credit facts. Powers the tmdb-keyed film page
 * reached from the "All films" grid — unlike the log-keyed detail page, this
 * resolves for films that were marked watched but never got a diary entry. Null
 * if the movie isn't cached. Selects the credit columns leniently, stepping down
 * through migration tiers (0009 → 0008 → base) so it keeps working whichever
 * migrations have been applied.
 */
export async function getFilmByTmdbId(tmdbId: number): Promise<FilmByTmdb | null> {
	const BASE = 'id, tmdb_id, title, release_year, poster_path, backdrop_path, overview, runtime';
	const W = 'watched(rating, liked, first_watched)';
	const tiers = [
		`${BASE}, genres, directors, actors, countries, original_language, mpa_rating, ${W}`, // 0008+0009
		`${BASE}, genres, directors, actors, countries, ${W}`, // 0008 only
		`${BASE}, ${W}`, // pre-0008
	];

	let data: unknown = null;
	let lastError: { code?: string; message?: string } | null = null;
	for (const cols of tiers) {
		const res = await supabasePublic.from('movies').select(cols).eq('tmdb_id', tmdbId).maybeSingle();
		if (!res.error) {
			data = res.data;
			lastError = null;
			break;
		}
		lastError = res.error;
		if (!isMissingCreditColumn(res.error)) break; // a real error — stop stepping down
	}
	if (lastError) throw new Error(`getFilmByTmdbId failed: ${lastError.message}`);
	if (!data) return null;

	const { watched, genres, directors, actors, countries, original_language, mpa_rating, ...rest } =
		data as Omit<FilmByTmdb['movie'], 'genres' | 'directors' | 'actors' | 'countries' | 'original_language' | 'mpa_rating'> & {
			genres?: string[] | null;
			directors?: string[] | null;
			actors?: string[] | null;
			countries?: string[] | null;
			original_language?: string | null;
			mpa_rating?: string | null;
			watched: WatchedActivity[] | WatchedActivity | null;
		};
	const w = Array.isArray(watched) ? (watched[0] ?? null) : (watched ?? null);
	return {
		movie: {
			...rest,
			genres: genres ?? [],
			directors: directors ?? [],
			actors: actors ?? [],
			countries: countries ?? [],
			original_language: original_language ?? null,
			mpa_rating: mpa_rating ?? null,
		},
		watched: w,
	};
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
 * "Favorite films" — the (≤4) watched films flagged `favorite` (migration 0006),
 * in your chosen order (`favorite_rank`, migration 0007; newest-watched as a
 * fallback). Each tile links to the film's latest diary entry when one exists.
 * Returns [] (and warns) if the columns aren't there yet, so the overview keeps
 * rendering before the migrations are applied.
 */
export async function listFavorites(limit = 4): Promise<FilmTile[]> {
	try {
		// Prefer the user-defined order; fall back to newest-watched if favorite_rank
		// (0007) isn't there yet.
		let { data, error } = await supabasePublic
			.from('watched')
			.select(
				'movie_id, rating, first_watched, favorite_rank, movies!inner(tmdb_id, title, release_year, poster_path)',
			)
			.eq('favorite', true)
			.order('favorite_rank', { ascending: true, nullsFirst: false })
			.order('first_watched', { ascending: false })
			.limit(limit);
		if (error) {
			({ data, error } = await supabasePublic
				.from('watched')
				.select(
					'movie_id, rating, first_watched, movies!inner(tmdb_id, title, release_year, poster_path)',
				)
				.eq('favorite', true)
				.order('first_watched', { ascending: false })
				.limit(limit));
		}
		if (error) throw error;

		const rows = (data ?? []) as unknown as {
			movie_id: number;
			rating: number | null;
			movies: { tmdb_id: number; title: string; release_year: number | null; poster_path: string | null };
		}[];
		if (rows.length === 0) return [];

		// Resolve a detail-page target (latest live log) per favorite movie.
		const logByMovie = await latestLogIdByMovie(rows.map((r) => r.movie_id));
		return rows.map((r) => ({
			logId: logByMovie.get(r.movie_id) ?? null,
			tmdb_id: r.movies.tmdb_id,
			title: r.movies.title,
			release_year: r.movies.release_year,
			poster_path: r.movies.poster_path,
			rating: r.rating,
			watched_date: null,
		}));
	} catch (e) {
		console.warn(
			'listFavorites: favorites unavailable (has migration 0006 been applied?):',
			e instanceof Error ? e.message : e,
		);
		return [];
	}
}

/** movie_id → its most recent live (non-deleted) log id, for the given movies. */
async function latestLogIdByMovie(movieIds: number[]): Promise<Map<number, number>> {
	const map = new Map<number, number>();
	if (movieIds.length === 0) return map;
	const { data, error } = await supabasePublic
		.from('logs')
		.select('id, movie_id')
		.in('movie_id', movieIds)
		.is('deleted_at', null)
		.order('watched_date', { ascending: false, nullsFirst: false })
		.order('created_at', { ascending: false });
	if (error) throw new Error(`latestLogIdByMovie failed: ${error.message}`);
	for (const row of (data ?? []) as { id: number; movie_id: number }[]) {
		if (!map.has(row.movie_id)) map.set(row.movie_id, row.id);
	}
	return map;
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

/** A watched-film poster tile for the "All films" browse grid. */
export interface WatchedFilm {
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	/** First time the film was marked watched — the "Recent" sort key. */
	first_watched: string;
}

/**
 * Every distinct film marked watched, most-recently-watched first. Powers the
 * "All films" grid at /films/watched. Search and sort (recent / year) happen
 * client-side, so this is a single flat read.
 */
export async function listAllWatched(): Promise<WatchedFilm[]> {
	// PostgREST caps a single response at 1,000 rows, and the collection is larger,
	// so page through it explicitly.
	const PAGE = 1000;
	const out: WatchedFilm[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select('first_watched, movies!inner(tmdb_id, title, release_year, poster_path)')
			.order('first_watched', { ascending: false })
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(`listAllWatched failed: ${error.message}`);
		const rows = (data ?? []) as unknown as { first_watched: string; movies: WatchlistTile }[];
		for (const r of rows) out.push({ ...r.movies, first_watched: r.first_watched });
		if (rows.length < PAGE) break;
	}
	return out;
}

// --- Favorites (migration 0006) ---

/**
 * Search your WATCHED films by title — favorites can only be chosen from films
 * you've actually seen. Case-insensitive substring match, most-recently-watched
 * first. (Does not touch the `favorite` column, so it works pre-migration.)
 */
export async function searchWatchedMovies(query: string, limit = 12): Promise<WatchlistTile[]> {
	const q = query.trim();
	if (!q) return [];
	const { data, error } = await supabasePublic
		.from('watched')
		.select('first_watched, movies!inner(tmdb_id, title, release_year, poster_path)')
		.ilike('movies.title', `%${q}%`)
		.order('first_watched', { ascending: false })
		.limit(limit);
	if (error) throw new Error(`searchWatchedMovies failed: ${error.message}`);
	return ((data ?? []) as unknown as { movies: WatchlistTile }[]).map((r) => r.movies);
}

/** Thrown when adding a favorite would exceed the cap of four. */
export class FavoritesFullError extends Error {
	constructor() {
		super('You can feature at most 4 favorite films.');
		this.name = 'FavoritesFullError';
	}
}

/**
 * Flag / unflag a watched film as a favorite. The film must already be in
 * `watched` (you can only favorite something you've seen). The 4-favorite cap is
 * checked here for a friendly error; the DB trigger (migration 0006) is the hard
 * guarantee. Idempotent — setting the current value is a no-op.
 */
export async function setFavorite(tmdbId: number, favorite: boolean): Promise<void> {
	const { data: movie, error: mErr } = await supabaseAdmin
		.from('movies')
		.select('id')
		.eq('tmdb_id', tmdbId)
		.maybeSingle();
	if (mErr) throw new Error(mErr.message);
	if (!movie) throw new Error('film not found');

	const { data: w, error: wErr } = await supabaseAdmin
		.from('watched')
		.select('id, favorite')
		.eq('movie_id', movie.id)
		.maybeSingle();
	if (wErr) throw new Error(wErr.message);
	if (!w) throw new Error('you can only favorite a film you have watched');
	if (w.favorite === favorite) return; // already in the desired state

	if (favorite) {
		// Cap at four; append to the end of the current order.
		const { data: favs, error: cErr } = await supabaseAdmin
			.from('watched')
			.select('favorite_rank')
			.eq('favorite', true);
		if (cErr) throw new Error(cErr.message);
		if ((favs?.length ?? 0) >= 4) throw new FavoritesFullError();
		const nextRank =
			(favs ?? []).reduce((m, r) => Math.max(m, (r.favorite_rank as number) ?? -1), -1) + 1;
		const { error } = await supabaseAdmin
			.from('watched')
			.update({ favorite: true, favorite_rank: nextRank })
			.eq('id', w.id);
		if (error) throw new Error(error.message);
	} else {
		const { error } = await supabaseAdmin
			.from('watched')
			.update({ favorite: false, favorite_rank: null })
			.eq('id', w.id);
		if (error) throw new Error(error.message);
	}
}

/**
 * Persist a new favorites order (from drag-and-drop). `orderedTmdbIds` is the full
 * favorites list in display order; each gets favorite_rank = its index. Ids that
 * aren't currently favorites are ignored, so a stale client can't create phantoms.
 */
export async function reorderFavorites(orderedTmdbIds: number[]): Promise<void> {
	const { data, error } = await supabaseAdmin
		.from('watched')
		.select('id, movies!inner(tmdb_id)')
		.eq('favorite', true);
	if (error) throw new Error(error.message);

	const idByTmdb = new Map<number, number>();
	for (const r of (data ?? []) as unknown as { id: number; movies: { tmdb_id: number } }[]) {
		idByTmdb.set(r.movies.tmdb_id, r.id);
	}

	let rank = 0;
	const updates: Promise<void>[] = [];
	for (const tmdbId of orderedTmdbIds) {
		const watchedId = idByTmdb.get(tmdbId);
		if (watchedId == null) continue;
		const at = rank++;
		updates.push(
			supabaseAdmin
				.from('watched')
				.update({ favorite_rank: at })
				.eq('id', watchedId)
				.then(({ error: uErr }) => {
					if (uErr) throw new Error(uErr.message);
				}),
		);
	}
	await Promise.all(updates);
}

// --- Stats page aggregates (migration 0008 credit/genre facts) ---

/** A ranked name + film count (genres / languages / countries). */
export interface RankedCount {
	name: string;
	count: number;
}

/** A ranked person with film count and average star rating of their films. */
export interface PersonStat {
	name: string;
	count: number;
	/** Mean rating across that person's films in scope; null if none are rated. */
	rating: number | null;
}

/** A labelled bar in a histogram. */
export interface HistBar {
	count: number;
	/** Tooltip text — e.g. "2024 · 132 films" or "Mar 3–9, 2024 · 2 films". */
	title: string;
}

/** One selectable timespan for the year picker. */
export interface YearOption {
	/** Calendar year, or 'all' for the all-time view. */
	key: number | 'all';
	label: string;
	/** Films watched in that year ('' for the all-time row). */
	count: string;
}

/** Everything the Stats page renders for one selected timespan. */
export interface FilmStats {
	scope: number | 'all';
	/** Picker options: "All time" plus each year with a meaningful sample (>10 films). */
	yearOptions: YearOption[];
	selectedLabel: string;
	metrics: { value: string; label: string }[];

	/** Films watched per week of the selected year (year scope only). */
	showWeeks: boolean;
	weeks: HistBar[];
	weekLabels: string[];
	weekSpan: string;
	weekAvg: string;

	/** Films watched, bucketed by their release year (all-time scope only). */
	showByYear: boolean;
	byYear: HistBar[];
	byYearLabels: string[];

	/** Ratings distribution, 10 buckets (index 0 = ½★ … 9 = 5★). */
	ratings: number[];
	ratingAvg: string;
	ratedTotal: number;

	genres: RankedCount[];
	languages: RankedCount[];
	countries: RankedCount[];
	directors: PersonStat[];
	actors: PersonStat[];
}

/** A watched film flattened with the movie facts the Stats page aggregates over. */
interface WatchedFacts {
	first_watched: string;
	rating: number | null;
	release_year: number | null;
	runtime: number | null;
	genres: string[];
	countries: string[];
	directors: string[];
	actors: string[];
	/** Original language (migration 0009), the "Languages" breakdown key; null if unsynced. */
	originalLanguage: string | null;
}

/**
 * Load every watched film with its movie facts (paged past the 1,000-row cap).
 * Steps down through migration tiers (0009 → 0008 → base) so the Stats page keeps
 * rendering whichever migrations are applied: before a tier lands, the sections
 * that depend on its columns simply come back empty until the backfill runs.
 */
async function loadWatchedFacts(): Promise<WatchedFacts[]> {
	const PAGE = 1000;
	const tiers = [
		'movies!inner(release_year, runtime, genres, countries, directors, actors, original_language)', // 0009
		'movies!inner(release_year, runtime, genres, countries, directors, actors)', // 0008
		'movies!inner(release_year, runtime)', // pre-0008
	];
	let tier = 0;
	const out: WatchedFacts[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select(`first_watched, rating, ${tiers[tier]}`)
			.order('first_watched', { ascending: false })
			.range(offset, offset + PAGE - 1);
		if (error) {
			// Columns not there yet: drop to the next tier and restart from the top.
			if (tier < tiers.length - 1 && isMissingCreditColumn(error)) {
				tier++;
				offset = -PAGE; // next loop iteration resumes at offset 0
				out.length = 0;
				continue;
			}
			throw new Error(`loadWatchedFacts failed: ${error.message}`);
		}
		const rows = (data ?? []) as unknown as {
			first_watched: string;
			rating: number | null;
			movies: {
				release_year: number | null;
				runtime: number | null;
				genres?: string[] | null;
				countries?: string[] | null;
				directors?: string[] | null;
				actors?: string[] | null;
				original_language?: string | null;
			};
		}[];
		for (const r of rows) {
			out.push({
				first_watched: r.first_watched,
				rating: r.rating,
				release_year: r.movies.release_year,
				runtime: r.movies.runtime,
				genres: r.movies.genres ?? [],
				countries: r.movies.countries ?? [],
				directors: r.movies.directors ?? [],
				actors: r.movies.actors ?? [],
				originalLanguage: r.movies.original_language ?? null,
			});
		}
		if (rows.length < PAGE) break;
	}
	return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Tally a name→count map from each film's list, most-common first, top `limit`. */
function rankCounts(rows: WatchedFacts[], pick: (r: WatchedFacts) => string[], limit = 7): RankedCount[] {
	const counts = new Map<string, number>();
	for (const r of rows) {
		for (const name of pick(r)) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, limit);
}

/** Rank people by film count, carrying each person's average film rating. */
function rankPeople(rows: WatchedFacts[], pick: (r: WatchedFacts) => string[], limit = 6): PersonStat[] {
	const agg = new Map<string, { count: number; ratingSum: number; rated: number }>();
	for (const r of rows) {
		for (const name of pick(r)) {
			const a = agg.get(name) ?? { count: 0, ratingSum: 0, rated: 0 };
			a.count++;
			if (r.rating != null) {
				a.ratingSum += r.rating;
				a.rated++;
			}
			agg.set(name, a);
		}
	}
	return [...agg.entries()]
		.map(([name, a]) => ({
			name,
			count: a.count,
			rating: a.rated ? a.ratingSum / a.rated : null,
		}))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, limit);
}

/** Year (local) of an ISO timestamp. */
function yearOf(iso: string): number {
	return new Date(iso).getFullYear();
}

/**
 * Aggregate the film-log Stats for one timespan. `scope` is a calendar year or
 * 'all'. Reads every watched film once and computes in-process, so a whole page
 * (metrics, histograms, ranked lists) is one DB round-trip. Genre/credit lists
 * come from the movie facts backfilled in migration 0008 — films whose facts
 * aren't synced yet simply contribute nothing to those sections.
 */
export async function getFilmStats(scope: number | 'all' = 'all'): Promise<FilmStats> {
	const all = await loadWatchedFacts();

	// Picker options: years with a meaningful sample, newest first.
	const perYear = new Map<number, number>();
	for (const r of all) perYear.set(yearOf(r.first_watched), (perYear.get(yearOf(r.first_watched)) ?? 0) + 1);
	const eligibleYears = [...perYear.entries()]
		.filter(([, c]) => c > 10)
		.map(([y]) => y)
		.sort((a, b) => b - a);
	const yearOptions: YearOption[] = [
		{ key: 'all', label: 'All time', count: '' },
		...eligibleYears.map((y) => ({ key: y, label: String(y), count: `${perYear.get(y)} films` })),
	];

	// Fall back to all-time if asked for a year outside the eligible set.
	const isAll = scope === 'all' || !eligibleYears.includes(scope as number);
	const selected: number | 'all' = isAll ? 'all' : (scope as number);
	const rows = isAll ? all : all.filter((r) => yearOf(r.first_watched) === selected);

	// Metrics.
	const filmsWatched = rows.length;
	const hours = Math.round(rows.reduce((a, r) => a + (r.runtime ?? 0), 0) / 60);
	const rated = rows.filter((r) => r.rating != null) as (WatchedFacts & { rating: number })[];
	const avgRating = rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : 0;
	const num = (n: number) => n.toLocaleString('en-US');
	const thisYear = new Date().getFullYear();
	const thisYearCount = all.filter((r) => yearOf(r.first_watched) === thisYear).length;
	const metrics = isAll
		? [
				{ value: num(filmsWatched), label: 'Films watched' },
				{ value: num(hours), label: 'Hours' },
				{ value: num(thisYearCount), label: 'This year' },
				{ value: rated.length ? avgRating.toFixed(1) : '—', label: 'Avg rating' },
			]
		: [
				{ value: num(filmsWatched), label: 'Films watched' },
				{ value: num(hours), label: 'Hours' },
				{ value: (filmsWatched / 52).toFixed(1), label: 'Films / week' },
				{ value: rated.length ? avgRating.toFixed(1) : '—', label: 'Avg rating' },
			];

	// Films watched per week (year scope): 7-day bins across the calendar year.
	let weeks: HistBar[] = [];
	let weekLabels: string[] = [];
	let weekSpan = '';
	let weekAvg = '0';
	if (!isAll) {
		const year = selected as number;
		const yearStart = new Date(year, 0, 1);
		const bins: number[] = [];
		const ranges: { start: Date; end: Date }[] = [];
		for (let d = new Date(yearStart); d.getFullYear() === year; d.setDate(d.getDate() + 7)) {
			const start = new Date(d);
			const end = new Date(d);
			end.setDate(end.getDate() + 6);
			if (end.getFullYear() > year) end.setTime(new Date(year, 11, 31).getTime());
			ranges.push({ start, end });
			bins.push(0);
		}
		for (const r of rows) {
			const days = Math.floor((new Date(r.first_watched).getTime() - yearStart.getTime()) / 86400000);
			const idx = Math.min(bins.length - 1, Math.max(0, Math.floor(days / 7)));
			bins[idx]++;
		}
		const fmtRange = (s: Date, e: Date) => {
			const a = `${MONTHS[s.getMonth()]} ${s.getDate()}`;
			const b = s.getMonth() === e.getMonth() ? `${e.getDate()}` : `${MONTHS[e.getMonth()]} ${e.getDate()}`;
			return `${a}–${b}, ${e.getFullYear()}`;
		};
		weeks = bins.map((c, i) => ({
			count: c,
			title: `${fmtRange(ranges[i].start, ranges[i].end)} · ${c} ${c === 1 ? 'film' : 'films'}`,
		}));
		weekLabels = ['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'];
		weekSpan = `${year} · week by week`;
		weekAvg = (bins.reduce((a, b) => a + b, 0) / (bins.length || 1)).toFixed(1);
	}

	// Films by release year (all-time scope): one bar per year, earliest → now.
	let byYear: HistBar[] = [];
	let byYearLabels: string[] = [];
	if (isAll) {
		const releaseYears = rows.map((r) => r.release_year).filter((y): y is number => y != null);
		if (releaseYears.length) {
			const min = Math.min(...releaseYears);
			const max = Math.max(...releaseYears, thisYear);
			const perRelease = new Map<number, number>();
			for (const y of releaseYears) perRelease.set(y, (perRelease.get(y) ?? 0) + 1);
			for (let y = min; y <= max; y++) {
				const c = perRelease.get(y) ?? 0;
				byYear.push({ count: c, title: `${y} · ${c} ${c === 1 ? 'film' : 'films'}` });
			}
			// ~6 evenly spaced year labels across the span.
			const span = max - min;
			byYearLabels = Array.from({ length: 6 }, (_, i) => String(Math.round(min + (span * i) / 5)));
		}
	}

	// Ratings distribution (0.5 … 5.0 → 10 buckets).
	const ratings = new Array(10).fill(0);
	let ratedTotal = 0;
	let ratingWeighted = 0;
	for (const r of rated) {
		const idx = Math.round(r.rating * 2) - 1;
		if (idx >= 0 && idx < 10) {
			ratings[idx]++;
			ratedTotal++;
			ratingWeighted += r.rating;
		}
	}
	const ratingAvg = ratedTotal ? (ratingWeighted / ratedTotal).toFixed(1) : '—';

	return {
		scope: selected,
		yearOptions,
		selectedLabel: isAll ? 'All time' : String(selected),
		metrics,
		showWeeks: !isAll,
		weeks,
		weekLabels,
		weekSpan,
		weekAvg,
		showByYear: isAll,
		byYear,
		byYearLabels,
		ratings,
		ratingAvg,
		ratedTotal,
		genres: rankCounts(rows, (r) => r.genres),
		languages: rankCounts(rows, (r) => (r.originalLanguage ? [r.originalLanguage] : [])),
		countries: rankCounts(rows, (r) => r.countries),
		directors: rankPeople(rows, (r) => r.directors),
		actors: rankPeople(rows, (r) => r.actors),
	};
}
