// Service layer that sits between the API routes and Supabase/TMDB.
// Endpoints stay thin; the "check cache → maybe fetch TMDB → write" logic lives
// here so it's written once.
import { supabaseAdmin, supabasePublic } from './supabase';
import { extractCreditFacts, getMovieDetails, preferredReleaseDate, releaseYear } from './tmdb';

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
	// Prefer the US theatrical release over TMDB's earliest-anywhere release_date,
	// and derive the year from that same date so the year and the full date can't
	// disagree (a foreign premiere and the US run can straddle a New Year).
	const releasedOn = preferredReleaseDate(d);
	const now = new Date().toISOString();
	const base = {
		tmdb_id: d.id,
		title: d.title,
		release_year: releaseYear(releasedOn),
		poster_path: d.poster_path,
		backdrop_path: d.backdrop_path,
		overview: d.overview,
		runtime: d.runtime,
		last_synced_at: now,
	};
	// Genre + credit facts for the Stats page (migration 0008) and the full release
	// date the Watchlist's upcoming badge needs (0014). The backfill fills these in
	// bulk for existing films; this keeps them fresh for anything logged from now
	// on. If those migrations haven't been applied yet, fall back to the base
	// columns so caching a movie still works.
	const withFacts = {
		...base,
		release_date: releasedOn,
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
	/** Names of the people watched with. */
	friends?: string[];
	/** How it was watched: 'theater' | 'tv' | 'computer' | 'plane' | free text. */
	medium?: string | null;
	/** Theater as a single "Name, City" string (theater medium only). */
	venue?: string | null;
	/** Presentation format name, e.g. "IMAX 70mm" (theater medium only). */
	format?: string | null;
}

/** Fields an edit can change on an existing diary log. Only the keys present are
 * applied; `tags` / `friends`, when present, replace the whole set. */
export interface UpdateLogInput {
	rating?: number | null;
	reviewText?: string | null;
	watchedDate?: string | null;
	rewatched?: boolean;
	liked?: boolean;
	/** Canonical medium ('theater' | 'tv' | …) or free text; null clears it. */
	medium?: string | null;
	/** Theater as "Name, City" (theater medium only). */
	venue?: string | null;
	/** Presentation format (theater medium only). */
	format?: string | null;
	/** Full replacement set of tag names. */
	tags?: string[];
	/** Full replacement set of friend names. */
	friends?: string[];
}

/** Upsert the film-level "watched" record (mark the movie seen). Never touches
 * rating/liked — a bare "I saw it" carries no opinion, and syncFilmRating owns
 * those. Idempotent via the movie_id unique constraint: re-logging keeps the
 * original first_watched. */
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

/**
 * Push a viewing's rating/like up to the film-level `watched` row.
 *
 * Two columns hold a rating and both are real (migration 0003): `watched.rating`
 * is what you think of the FILM, `logs.rating` is what you thought that night.
 * ~500 imported films have only the former — they never got a dated entry — so
 * logs can't stand alone. The newest viewing is the newest opinion, so it owns
 * the film-level value.
 *
 * Only ever writes the fields an entry actually carries: an unrated log must not
 * blank a film's rating, and ~74 films rate the film differently from their last
 * log (a later re-rate on Letterboxd). Likewise `liked` only ever goes true —
 * a rewatch you didn't tick shouldn't unlike the film.
 */
async function syncFilmRating(
	movieId: number,
	patch: { rating?: number; liked?: true },
): Promise<void> {
	if (Object.keys(patch).length === 0) return;
	const { error } = await supabaseAdmin.from('watched').update(patch).eq('movie_id', movieId);
	if (error) throw new Error(`sync film rating failed: ${error.message}`);
}

/**
 * Whether `logId` is the film's most recent rated viewing — the entry whose rating
 * stands as the film-level opinion. Undated logs sort last; newest id breaks ties.
 * Editing an older entry's rating is editing history, and leaves the film alone.
 */
async function isNewestRatedLog(movieId: number, logId: number): Promise<boolean> {
	const { data, error } = await supabaseAdmin
		.from('logs')
		.select('id')
		.eq('movie_id', movieId)
		.is('deleted_at', null)
		.not('rating', 'is', null)
		.order('watched_date', { ascending: false, nullsFirst: false })
		.order('id', { ascending: false })
		.limit(1);
	if (error) throw new Error(`newest rated log lookup failed: ${error.message}`);
	return data?.[0]?.id === logId;
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
		(typeof input.medium === 'string' && input.medium.trim().length > 0) ||
		(Array.isArray(input.tags) && input.tags.some((t) => t.trim().length > 0)) ||
		(Array.isArray(input.friends) && input.friends.some((f) => f.trim().length > 0))
	);
}

/** Split a "Name, City" venue string into its parts (city = text after the last comma). */
export function parseVenue(venue: string): { name: string; city: string | null } {
	const s = venue.trim();
	const i = s.lastIndexOf(',');
	if (i === -1) return { name: s, city: null };
	const name = s.slice(0, i).trim();
	const city = s.slice(i + 1).trim() || null;
	return { name: name || s, city };
}

/** Upsert a theater by (name, city) and return its id. */
async function resolveTheaterId(venue: string): Promise<number | null> {
	const { name, city } = parseVenue(venue);
	if (!name) return null;
	const { data, error } = await supabaseAdmin
		.from('theaters')
		.upsert({ name, city }, { onConflict: 'name,city' })
		.select('id')
		.single();
	if (error) throw new Error(`resolve theater failed: ${error.message}`);
	return (data as { id: number }).id;
}

/** Upsert a format by name and return its id. */
async function resolveFormatId(format: string): Promise<number | null> {
	const name = format.trim();
	if (!name) return null;
	const { data, error } = await supabaseAdmin
		.from('formats')
		.upsert({ name }, { onConflict: 'name' })
		.select('id')
		.single();
	if (error) throw new Error(`resolve format failed: ${error.message}`);
	return (data as { id: number }).id;
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

	// Resolve how it was watched. theater/format only apply to theater viewings;
	// a theater screening with no format given defaults to "Digital".
	const medium = input.medium?.trim().toLowerCase() || null;
	const inTheater = medium === 'theater';
	const theaterId = inTheater && input.venue?.trim() ? await resolveTheaterId(input.venue) : null;
	const formatName = inTheater ? input.format?.trim() || 'Digital' : null;
	const formatId = formatName ? await resolveFormatId(formatName) : null;

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
			medium,
			theater_id: theaterId,
			format_id: formatId,
		})
		.select('id')
		.single();
	if (error) throw new Error(`insert log failed: ${error.message}`);

	const tags = normalizeTags(input.tags);
	if (tags.length > 0) await attachTags(log.id, tags);

	const friends = normalizeFriends(input.friends);
	if (friends.length > 0) await attachFriends(log.id, friends);

	// A new entry is the newest opinion of the film, so it sets the film-level
	// rating/like the grid, stats and favorites all read.
	await syncFilmRating(movie.id, {
		...(input.rating != null ? { rating: input.rating } : {}),
		...(input.liked ? { liked: true as const } : {}),
	});

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

/** Replace a log's entire tag set: drop the existing links, attach the new names. */
async function replaceTags(logId: number, names: string[] | undefined): Promise<void> {
	const { error } = await supabaseAdmin.from('log_tags').delete().eq('log_id', logId);
	if (error) throw new Error(`clear tags failed: ${error.message}`);
	const norm = normalizeTags(names);
	if (norm.length > 0) await attachTags(logId, norm);
}

/**
 * Trim and de-duplicate friend names. Unlike tags these keep the casing they were
 * typed in — they're people's names — so duplicates are collapsed case-insensitively
 * while the first spelling wins.
 */
function normalizeFriends(friends: string[] | undefined): string[] {
	if (!friends) return [];
	const byKey = new Map<string, string>();
	for (const raw of friends) {
		const name = raw.trim();
		if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
	}
	return [...byKey.values()];
}

/**
 * Resolve friend names to ids, creating rows for the ones we haven't seen before.
 * Tags can upsert straight on `name` because they're already lowercased; friends
 * keep their typed casing, so an existing "Mia Tanaka" is matched case-insensitively
 * here rather than inserting a second row for "mia tanaka".
 */
async function resolveFriendIds(names: string[]): Promise<number[]> {
	const { data: existing, error: readErr } = await supabaseAdmin.from('friends').select('id, name');
	if (readErr) throw new Error(`lookup friends failed: ${readErr.message}`);

	const idByKey = new Map<string, number>();
	for (const f of (existing ?? []) as { id: number; name: string }[]) {
		idByKey.set(f.name.trim().toLowerCase(), f.id);
	}

	const missing = names.filter((n) => !idByKey.has(n.toLowerCase()));
	if (missing.length > 0) {
		const { data: inserted, error: insErr } = await supabaseAdmin
			.from('friends')
			.insert(missing.map((name) => ({ name })))
			.select('id, name');
		if (insErr) throw new Error(`create friends failed: ${insErr.message}`);
		for (const f of (inserted ?? []) as { id: number; name: string }[]) {
			idByKey.set(f.name.trim().toLowerCase(), f.id);
		}
	}

	return names.map((n) => idByKey.get(n.toLowerCase())!).filter((id) => id != null);
}

/** Link friend names to a log, creating any that don't exist yet. */
async function attachFriends(logId: number, names: string[]): Promise<void> {
	const ids = await resolveFriendIds(names);
	if (ids.length === 0) return;
	const links = ids.map((friend_id) => ({ log_id: logId, friend_id }));
	const { error } = await supabaseAdmin.from('log_friends').insert(links);
	if (error) throw new Error(`link friends failed: ${error.message}`);
}

/** Replace a log's entire friend set: drop the existing links, attach the new names. */
async function replaceFriends(logId: number, names: string[] | undefined): Promise<void> {
	const { error } = await supabaseAdmin.from('log_friends').delete().eq('log_id', logId);
	if (error) throw new Error(`clear friends failed: ${error.message}`);
	const norm = normalizeFriends(names);
	if (norm.length > 0) await attachFriends(logId, norm);
}

/**
 * Edit an existing (non-deleted) diary log. Applies only the provided fields.
 * `medium` follows the same rules as logging: a theater viewing resolves a
 * theater + format (defaulting to "Digital"), any other medium clears both.
 * `tags` / `friends`, when provided, replace the log's whole set. Returns false
 * when the log doesn't exist or is soft-deleted.
 */
export async function updateLog(id: number, input: UpdateLogInput): Promise<boolean> {
	const patch: Record<string, unknown> = {};
	if ('rating' in input) patch.rating = input.rating ?? null;
	if ('reviewText' in input) patch.review_text = input.reviewText ?? null;
	if ('watchedDate' in input) patch.watched_date = input.watchedDate ?? null;
	if ('rewatched' in input) patch.rewatched = input.rewatched ?? false;
	if ('liked' in input) patch.liked = input.liked ?? false;
	if ('medium' in input) {
		const medium = input.medium?.trim() ? input.medium.trim().toLowerCase() : null;
		const inTheater = medium === 'theater';
		const theaterId = inTheater && input.venue?.trim() ? await resolveTheaterId(input.venue) : null;
		const formatName = inTheater ? input.format?.trim() || 'Digital' : null;
		const formatId = formatName ? await resolveFormatId(formatName) : null;
		patch.medium = medium;
		patch.theater_id = theaterId;
		patch.format_id = formatId;
	}

	// The row must exist (and be live) before we touch columns, tags or friends.
	if (Object.keys(patch).length > 0) {
		const { data, error } = await supabaseAdmin
			.from('logs')
			.update(patch)
			.eq('id', id)
			.is('deleted_at', null)
			.select('id, movie_id')
			.maybeSingle();
		if (error) throw new Error(`updateLog failed: ${error.message}`);
		if (!data) return false;

		// Re-rating the film's latest viewing is re-rating the film. Guarded on the
		// rating actually being in the patch: editing an old entry's tags must not
		// drag the film-level rating down to that night's score.
		if ('rating' in input && input.rating != null && (await isNewestRatedLog(data.movie_id, id))) {
			await syncFilmRating(data.movie_id, { rating: input.rating });
		}
		if (input.liked) await syncFilmRating(data.movie_id, { liked: true });
	} else if ('tags' in input || 'friends' in input) {
		const { data, error } = await supabaseAdmin
			.from('logs')
			.select('id')
			.eq('id', id)
			.is('deleted_at', null)
			.maybeSingle();
		if (error) throw new Error(`updateLog failed: ${error.message}`);
		if (!data) return false;
	}

	if ('tags' in input) await replaceTags(id, input.tags);
	if ('friends' in input) await replaceFriends(id, input.friends);
	return true;
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
 *
 * `id` breaks ties last so the total order is deterministic. Without it, logs
 * sharing a watched_date *and* a created_at (the Letterboxd import stamps a whole
 * batch with one timestamp) can order differently between two paged queries, which
 * makes the diary's infinite scroll serve one row twice and drop another.
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
		.order('id', { ascending: false })
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
 * Theater names as "Name, City" strings, for the composer's venue autocomplete.
 * Returns [] (not an error) before migration 0010 creates the table.
 */
export async function listTheaterNames(): Promise<string[]> {
	const { data, error } = await supabasePublic
		.from('theaters')
		.select('name, city')
		.order('name', { ascending: true });
	if (error) {
		if (isMissingCreditColumn(error)) return [];
		// Missing table (relation does not exist) also degrades to empty.
		if (error.code === '42P01' || (error.message ?? '').includes('does not exist')) return [];
		throw new Error(`listTheaterNames failed: ${error.message}`);
	}
	return ((data ?? []) as { name: string; city: string | null }[]).map((t) =>
		[t.name, t.city].filter(Boolean).join(', '),
	);
}

/**
 * Distinct tag names, alphabetical — for the composer/editor tag autocomplete.
 * Returns [] (not an error) before the tags table exists.
 */
export async function listTags(): Promise<string[]> {
	const { data, error } = await supabasePublic
		.from('tags')
		.select('name')
		.order('name', { ascending: true });
	if (error) {
		if (isMissingRelation(error)) return [];
		throw new Error(`listTags failed: ${error.message}`);
	}
	return ((data ?? []) as { name: string }[]).map((t) => t.name);
}

/**
 * Whether a PostgREST error is "this table/relationship isn't there yet" — i.e. a
 * migration hasn't been applied. Lets friends (migration 0013) degrade to empty
 * instead of breaking the pages that read them.
 */
function isMissingRelation(err: { code?: string; message?: string } | null): boolean {
	if (!err) return false;
	const msg = (err.message ?? '').toLowerCase();
	return (
		err.code === '42P01' || // undefined_table
		err.code === 'PGRST200' || // no such relationship in the schema cache
		msg.includes('does not exist') ||
		msg.includes('schema cache')
	);
}

/**
 * Friend names, alphabetical — for the composer/editor "watched with" autocomplete.
 * Returns [] (not an error) before migration 0013 creates the table.
 */
export async function listFriends(): Promise<string[]> {
	const { data, error } = await supabasePublic
		.from('friends')
		.select('name')
		.order('name', { ascending: true });
	if (error) {
		if (isMissingRelation(error)) return [];
		throw new Error(`listFriends failed: ${error.message}`);
	}
	return ((data ?? []) as { name: string }[]).map((f) => f.name);
}

/**
 * The people each of several logs was watched with, alphabetical, keyed by log
 * id — logs watched alone are absent rather than mapped to []. Read on its own
 * rather than embedded in the callers' selects so it can degrade to no friends
 * before migration 0013 without adding another dimension to their migration-tier
 * fallbacks.
 */
async function listFriendsForLogs(logIds: number[]): Promise<Map<number, string[]>> {
	const byLog = new Map<number, string[]>();
	if (logIds.length === 0) return byLog;
	const { data, error } = await supabasePublic
		.from('log_friends')
		.select('log_id, friends(name)')
		.in('log_id', logIds);
	if (error) {
		if (isMissingRelation(error)) return byLog;
		throw new Error(`listFriendsForLogs failed: ${error.message}`);
	}
	for (const lf of (data ?? []) as unknown as {
		log_id: number;
		friends: { name: string } | null;
	}[]) {
		const name = lf.friends?.name;
		if (!name) continue;
		const names = byLog.get(lf.log_id);
		if (names) names.push(name);
		else byLog.set(lf.log_id, [name]);
	}
	for (const names of byLog.values()) names.sort((a, b) => a.localeCompare(b));
	return byLog;
}

/** The people one log was watched with, alphabetical; [] when watched alone. */
async function listFriendsForLog(logId: number): Promise<string[]> {
	return (await listFriendsForLogs([logId])).get(logId) ?? [];
}

/** A PostgREST embed is an object or an array depending on the relationship. */
function embedOne<T>(v: T | T[] | null | undefined): T | null {
	return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** A single diary entry with everything the Diary Entry page renders. */
export interface DiaryEntry {
	id: number;
	watched_date: string | null;
	rating: number | null;
	review_text: string | null;
	rewatched: boolean;
	liked: boolean;
	created_at: string;
	/** How it was watched: 'theater' | 'tv' | 'computer' | 'plane' | free text | null. */
	medium: string | null;
	/** Set only for theater viewings. */
	theater: { name: string; city: string | null } | null;
	/** Presentation format name (e.g. "IMAX 70mm"); theater viewings only. */
	format: string | null;
	movie: {
		tmdb_id: number;
		title: string;
		release_year: number | null;
		poster_path: string | null;
		backdrop_path: string | null;
		directors: string[];
	};
	tags: string[];
	/** People this film was watched with; [] when watched alone. */
	friends: string[];
}

/**
 * One diary entry by log id, with its movie, director, medium, theater and format
 * — the read model for /films/diary/[id]. Steps down gracefully if migration 0010
 * (medium/theater/format) or 0008 (directors) isn't applied yet, so the page keeps
 * rendering with whatever columns exist. Null if the log doesn't exist / is deleted.
 */
export async function getDiaryEntry(id: number): Promise<DiaryEntry | null> {
	const BASE =
		'id, watched_date, rating, review_text, rewatched, liked, created_at, ' +
		'log_tags(tags(name))';
	const MOVIE_FULL = 'movies(tmdb_id, title, release_year, poster_path, backdrop_path, directors)';
	const MOVIE_BASE = 'movies(tmdb_id, title, release_year, poster_path, backdrop_path)';
	const HOW = 'medium, theaters(name, city), formats(name)';
	const tiers = [
		`${BASE}, ${HOW}, ${MOVIE_FULL}`, // 0010 + 0008
		`${BASE}, ${MOVIE_FULL}`, // 0008 only (no medium/theater/format)
		`${BASE}, ${MOVIE_BASE}`, // pre-0008
	];

	let data: unknown = null;
	let lastError: { code?: string; message?: string } | null = null;
	for (const cols of tiers) {
		const res = await supabasePublic
			.from('logs')
			.select(cols)
			.eq('id', id)
			.is('deleted_at', null)
			.maybeSingle();
		if (!res.error) {
			data = res.data;
			lastError = null;
			break;
		}
		lastError = res.error;
		if (!isMissingCreditColumn(res.error)) break; // a real error — stop stepping down
	}
	if (lastError) throw new Error(`getDiaryEntry failed: ${lastError.message}`);
	if (!data) return null;

	const row = data as {
		id: number;
		watched_date: string | null;
		rating: number | null;
		review_text: string | null;
		rewatched: boolean;
		liked: boolean;
		created_at: string;
		medium?: string | null;
		theaters?: { name: string; city: string | null } | { name: string; city: string | null }[] | null;
		formats?: { name: string } | { name: string }[] | null;
		movies: {
			tmdb_id: number;
			title: string;
			release_year: number | null;
			poster_path: string | null;
			backdrop_path: string | null;
			directors?: string[] | null;
		};
		log_tags: { tags: { name: string } }[];
	};
	const theater = embedOne(row.theaters);
	const format = embedOne(row.formats);
	const friends = await listFriendsForLog(row.id);
	return {
		id: row.id,
		watched_date: row.watched_date,
		rating: row.rating,
		review_text: row.review_text,
		rewatched: row.rewatched,
		liked: row.liked,
		created_at: row.created_at,
		medium: row.medium ?? null,
		theater: theater ? { name: theater.name, city: theater.city } : null,
		format: format ? format.name : null,
		movie: {
			tmdb_id: row.movies.tmdb_id,
			title: row.movies.title,
			release_year: row.movies.release_year,
			poster_path: row.movies.poster_path,
			backdrop_path: row.movies.backdrop_path,
			directors: row.movies.directors ?? [],
		},
		tags: (row.log_tags ?? []).map((lt) => lt.tags.name).sort(),
		friends,
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
 * A diary log for one movie, with everything a film page renders in "Your
 * reviews" *and* everything its Entry Editor seeds from when you edit one.
 */
export interface MovieEntry extends MovieLog {
	/** How it was watched: 'theater' | 'tv' | 'computer' | 'plane' | free text | null. */
	medium: string | null;
	/** Set only for theater viewings. */
	theater: { name: string; city: string | null } | null;
	/** Presentation format name (e.g. "IMAX 70mm"); theater viewings only. */
	format: string | null;
	tags: string[];
	/** People this film was watched with; [] when watched alone. */
	friends: string[];
}

/**
 * Every diary log for one movie, newest first, with the medium/tags/friends its
 * editor needs — the read model for /films/movie/[tmdbId]. Steps down gracefully
 * if migration 0010 (medium/theater/format) isn't applied yet, mirroring
 * getDiaryEntry, so the page keeps rendering with whatever columns exist.
 *
 * listLogsByMovie stays the lean read for callers that only need the ratings.
 */
export async function listMovieEntries(movieId: number): Promise<MovieEntry[]> {
	const BASE =
		'id, watched_date, rating, review_text, rewatched, liked, created_at, log_tags(tags(name))';
	const HOW = 'medium, theaters(name, city), formats(name)';
	const tiers = [`${BASE}, ${HOW}`, BASE];

	let data: unknown = null;
	let lastError: { code?: string; message?: string } | null = null;
	for (const cols of tiers) {
		const res = await supabasePublic
			.from('logs')
			.select(cols)
			.eq('movie_id', movieId)
			.is('deleted_at', null)
			.order('watched_date', { ascending: false, nullsFirst: false })
			.order('created_at', { ascending: false });
		if (!res.error) {
			data = res.data;
			lastError = null;
			break;
		}
		lastError = res.error;
		if (!isMissingCreditColumn(res.error)) break; // a real error — stop stepping down
	}
	if (lastError) throw new Error(`listMovieEntries failed: ${lastError.message}`);

	const rows = (data ?? []) as {
		id: number;
		watched_date: string | null;
		rating: number | null;
		review_text: string | null;
		rewatched: boolean;
		liked: boolean;
		created_at: string;
		medium?: string | null;
		theaters?: { name: string; city: string | null } | { name: string; city: string | null }[] | null;
		formats?: { name: string } | { name: string }[] | null;
		log_tags: { tags: { name: string } }[];
	}[];

	const friendsByLog = await listFriendsForLogs(rows.map((r) => r.id));
	return rows.map((row) => {
		const theater = embedOne(row.theaters);
		const format = embedOne(row.formats);
		return {
			id: row.id,
			watched_date: row.watched_date,
			rating: row.rating,
			review_text: row.review_text,
			rewatched: row.rewatched,
			liked: row.liked,
			created_at: row.created_at,
			medium: row.medium ?? null,
			theater: theater ? { name: theater.name, city: theater.city } : null,
			format: format ? format.name : null,
			tags: (row.log_tags ?? []).map((lt) => lt.tags.name).sort(),
			friends: friendsByLog.get(row.id) ?? [],
		};
	});
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
	/** Null when the first watch is unknown (Letterboxd-imported films — see migration 0011). */
	first_watched: string | null;
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
			.order('first_watched', { ascending: false, nullsFirst: false })
			.limit(limit);
		if (error) {
			({ data, error } = await supabasePublic
				.from('watched')
				.select(
					'movie_id, rating, first_watched, movies!inner(tmdb_id, title, release_year, poster_path)',
				)
				.eq('favorite', true)
				.order('first_watched', { ascending: false, nullsFirst: false })
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

/** A full watchlist entry for the watchlist page — tile fields plus when it was
 * added and the facts its filters read. */
export interface WatchlistEntry extends WatchlistTile {
	added_at: string;
	/** Cached TMDB genres (migration 0008); [] when never synced. */
	genres: string[];
	/** Full release date, "YYYY-MM-DD" (0014). Null when TMDB has no date — which
	 * for a watchlist is usually an announced film with nothing but a title. */
	release_date: string | null;
}

/** The entire watchlist, most recently added first — powers /films/watchlist.
 * Unpaged: the page filters and sorts the whole list in the browser, so it has to
 * ship all of it. Fine at a few hundred films; revisit if it reaches thousands. */
export async function listAllWatchlist(): Promise<WatchlistEntry[]> {
	const { data, error } = await supabasePublic
		.from('watchlist')
		.select('added_at, movies(tmdb_id, title, release_year, release_date, poster_path, genres)')
		.order('added_at', { ascending: false });
	if (error) throw new Error(`listAllWatchlist failed: ${error.message}`);
	type Row = { added_at: string; movies: WatchlistEntry & { genres: string[] | null } };
	return ((data ?? []) as unknown as Row[]).map((r) => ({
		...r.movies,
		genres: r.movies.genres ?? [],
		added_at: r.added_at,
	}));
}

/** A watched-film poster tile for the "All films" browse grid. */
export interface WatchedFilm {
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	/** First time the film was marked watched — the "Recent" sort key. Null when
	 * unknown (Letterboxd-imported films, migration 0011); those sort last. */
	first_watched: string | null;
	/** Film-level stars, 0.5–5.0 in half-steps; null when never rated. */
	rating: number | null;
}

/** Sort orders the "All films" grid offers. */
export type WatchedSort = 'recent' | 'year';

/** Whether every selected value must match, or just one of them. */
export type MatchMode = 'any' | 'all';

/** Which slice of the watched collection to read. */
export interface WatchedQuery {
	/** Case-insensitive title substring; '' matches everything. */
	q?: string;
	sort?: WatchedSort;
	limit?: number;
	offset?: number;

	// --- Film-level filters (columns on `watched` / `movies`) ---
	/** Inclusive star bounds. Unrated films fall outside any bound, so a narrowed
	 * range drops them. Omit both for "any rating". */
	ratingMin?: number;
	ratingMax?: number;
	/** Only films with no rating at all. Overrides ratingMin/ratingMax. */
	unratedOnly?: boolean;
	/** Only films liked at the film level. */
	liked?: boolean;
	/** Release decades as their first year, e.g. [1990, 2020]. Matches any of them. */
	decades?: number[];
	/** Exact release years, e.g. [2019]. Matches any of them. Narrower than `decades`
	 * — the Stats "Films by release year" bars link here. ANDs with `decades` when
	 * both are set, though the UI only ever sends one. */
	releaseYears?: number[];
	/** Matches films directed by any of these people (cached `movies.directors`). */
	directors?: string[];
	/** Matches films whose top-billed cast (`movies.actors`) includes any of these. */
	actors?: string[];
	/** Matches films tagged with any of these TMDB genres (cached `movies.genres`). */
	genres?: string[];
	/** Matches films whose original language (`movies.original_language`) is any of these. */
	languages?: string[];
	/** Matches films from any of these production countries (cached `movies.countries`). */
	countries?: string[];

	// --- Diary-date filter (spans a film's viewings, not its release) ---
	/** Inclusive calendar-year bounds on when the film was watched. A film watched
	 * across several years matches whenever ANY of those years falls in range, so a
	 * film seen in 2024 and 2026 answers to both. Read from each diary entry's
	 * `watched_date`, plus the film-level `first_watched` for imported films with no
	 * dated diary entry. Omit both for "any date". */
	diaryYearMin?: number;
	diaryYearMax?: number;

	// --- Log-level filters (true when ANY of the film's diary entries match) ---
	/** Only films with at least one rewatch entry. */
	rewatched?: boolean;
	/** Matches films carrying any of these tags. */
	tags?: string[];
	friends?: string[];
	friendMode?: MatchMode;
	mediums?: string[];
	/** Theaters as "Name, City" — the same spelling listTheaterNames returns. */
	venues?: string[];
	formats?: string[];
	/** Applied across mediums+venues+formats together, as the design's one toggle. */
	whereMode?: MatchMode;
}

export interface WatchedPage {
	films: WatchedFilm[];
	/** Films matching `q` across every page — not just the ones returned here. */
	total: number;
}

/** Whether a sort name is one we support; anything else falls back to 'recent'. */
export function isWatchedSort(v: unknown): v is WatchedSort {
	return v === 'recent' || v === 'year';
}

/** Whether a match-mode name is one we support; anything else falls back to 'any'. */
export function isMatchMode(v: unknown): v is MatchMode {
	return v === 'any' || v === 'all';
}

/**
 * The log-level facts about one film, unioned across all of its diary entries.
 *
 * The grid has one tile per *film* but tags, friends, medium, theater and format
 * all live on a *viewing*. Collapsing them per film is what lets a film-level
 * filter mean "any of my watches of this film matched" — so a film seen twice, at
 * the Angelika and then on a plane, answers to both.
 */
interface FilmLogDims {
	rewatched: boolean;
	tags: Set<string>;
	friends: Set<string>;
	mediums: Set<string>;
	/** "Name, City" — the spelling used by chips, the API and listTheaterNames. */
	venues: Set<string>;
	formats: Set<string>;
}

function emptyDims(): FilmLogDims {
	return {
		rewatched: false,
		tags: new Set(),
		friends: new Set(),
		mediums: new Set(),
		venues: new Set(),
		formats: new Set(),
	};
}

/**
 * Every live diary entry's filterable dimensions, folded into one entry per film.
 *
 * Read whole rather than pushed into the `watched` query because the filters span
 * four join tables with any/all semantics that PostgREST can't express in a single
 * request. The diary is a few hundred rows — small enough that one read plus an
 * in-process fold is cheaper than the query gymnastics, and it keeps the any/all
 * rules in plain TypeScript where they're legible. Revisit if the diary reaches
 * five figures.
 *
 * Degrades to an empty map before migrations 0010/0013 add the columns it reads,
 * which turns every log-level filter into a no-match rather than an error.
 */
async function loadFilmLogDims(): Promise<Map<number, FilmLogDims>> {
	const byMovie = new Map<number, FilmLogDims>();
	const { data, error } = await supabasePublic
		.from('logs')
		.select(
			'movie_id, rewatched, medium, theaters(name, city), formats(name), ' +
				'log_tags(tags(name)), log_friends(friends(name))',
		)
		.is('deleted_at', null);
	if (error) {
		if (isMissingRelation(error) || isMissingCreditColumn(error)) return byMovie;
		throw new Error(`loadFilmLogDims failed: ${error.message}`);
	}

	const one = <T>(v: T | T[] | null | undefined): T | null =>
		Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

	for (const row of (data ?? []) as unknown as {
		movie_id: number;
		rewatched: boolean | null;
		medium: string | null;
		theaters: { name: string; city: string | null } | { name: string; city: string | null }[] | null;
		formats: { name: string } | { name: string }[] | null;
		log_tags: { tags: { name: string } | null }[] | null;
		log_friends: { friends: { name: string } | null }[] | null;
	}[]) {
		let dims = byMovie.get(row.movie_id);
		if (!dims) {
			dims = emptyDims();
			byMovie.set(row.movie_id, dims);
		}
		if (row.rewatched) dims.rewatched = true;
		if (row.medium?.trim()) dims.mediums.add(row.medium.trim().toLowerCase());
		const theater = one(row.theaters);
		if (theater) dims.venues.add([theater.name, theater.city].filter(Boolean).join(', '));
		const format = one(row.formats);
		if (format) dims.formats.add(format.name);
		for (const lt of row.log_tags ?? []) if (lt.tags) dims.tags.add(lt.tags.name);
		for (const lf of row.log_friends ?? []) if (lf.friends) dims.friends.add(lf.friends.name);
	}
	return byMovie;
}

/** True when `selected` is satisfied by `have` under the given mode. Empty = no filter. */
function matches(selected: string[], have: Set<string>, mode: MatchMode): boolean {
	if (selected.length === 0) return true;
	return mode === 'all' ? selected.every((v) => have.has(v)) : selected.some((v) => have.has(v));
}

/** Whether the query constrains anything that lives on a diary entry. */
function hasLogFilters(q: WatchedQuery): boolean {
	return Boolean(
		q.rewatched ||
			q.tags?.length ||
			q.friends?.length ||
			q.mediums?.length ||
			q.venues?.length ||
			q.formats?.length,
	);
}

/**
 * The movie ids whose diary entries satisfy the query's log-level filters, or null
 * when it has none (i.e. "don't constrain by movie id at all" — distinct from an
 * empty array, which means nothing matched).
 */
async function movieIdsMatchingLogFilters(q: WatchedQuery): Promise<number[] | null> {
	if (!hasLogFilters(q)) return null;
	const dimsByMovie = await loadFilmLogDims();
	const friendMode = q.friendMode ?? 'any';
	const whereMode = q.whereMode ?? 'any';

	const ids: number[] = [];
	for (const [movieId, dims] of dimsByMovie) {
		if (q.rewatched && !dims.rewatched) continue;
		// Tags are always "any of these" — the design gives them no all/any toggle.
		if (!matches(q.tags ?? [], dims.tags, 'any')) continue;
		if (!matches(q.friends ?? [], dims.friends, friendMode)) continue;
		// Medium, theater and format share one toggle and are matched as a single
		// pool, mirroring the design's combined "Medium · theater · format" control.
		const where = [...(q.mediums ?? []), ...(q.venues ?? []), ...(q.formats ?? [])];
		const have = new Set([...dims.mediums, ...dims.venues, ...dims.formats]);
		if (!matches(where, have, whereMode)) continue;
		ids.push(movieId);
	}
	return ids;
}

/**
 * The chip values offered by the filter panel, derived from what's actually there.
 * Every list but `decades` is ordered by how many films carry the value, most
 * first, ties alphabetical.
 */
export interface WatchedFacets {
	/** Release decades as their first year, ascending — the slider's end stops. */
	decades: number[];
	/** Earliest / latest calendar year the collection was watched — the diary-date
	 * slider's end stops. Null when nothing carries a watch date. */
	diaryYearLo: number | null;
	diaryYearHi: number | null;
	tags: string[];
	friends: string[];
	/** Canonical medium values ('theater', 'tv', …). */
	mediums: string[];
	/** Theaters: `value` is "Name, City", `label` is the shortest unambiguous name. */
	venues: { value: string; label: string }[];
	formats: string[];
	/** Directors of watched films, most films first — the "People → Director" chips. */
	directors: string[];
	/** Top-billed cast of watched films, most films first — the "People → Cast" chips. */
	actors: string[];
	/** TMDB genres across watched films, most films first — the "Genre" chips. */
	genres: string[];
	/** Original languages across watched films, most films first — the "Language" chips. */
	languages: string[];
	/** Production countries across watched films, most films first — the "Country" chips. */
	countries: string[];
}

/**
 * Every value the filter chips can offer, read from the collection itself so a chip
 * can never match zero films. Tags/friends/mediums/venues/formats come from live
 * diary entries rather than the lookup tables, which also hold values stranded on
 * soft-deleted logs.
 */
export async function listWatchedFacets(): Promise<WatchedFacets> {
	const [dimsByMovie, years, theaterNames, credits, diaryYearsByMovie] = await Promise.all([
		loadFilmLogDims(),
		listWatchedReleaseYears(),
		theaterNameByValue(),
		watchedFilmFacetFrequency(),
		loadDiaryYearsByMovie(),
	]);

	// End stops for the diary-date slider: the earliest and latest calendar year
	// anything in the collection was watched, across every film's viewings.
	const diaryYears = new Set<number>();
	for (const set of diaryYearsByMovie.values()) for (const y of set) diaryYears.add(y);
	const diaryYearsAsc = [...diaryYears].sort((a, b) => a - b);
	const diaryYearLo = diaryYearsAsc[0] ?? null;
	const diaryYearHi = diaryYearsAsc[diaryYearsAsc.length - 1] ?? null;

	// Most-used first, ties alphabetical. The order is what the panel's collapse
	// limits cut against, so frequency is what keeps "+N other…" hiding the long
	// tail rather than an arbitrary alphabetical slice.
	const byFrequency = (pick: (d: FilmLogDims) => Set<string>): string[] => {
		const counts = new Map<string, number>();
		for (const dims of dimsByMovie.values()) {
			for (const v of pick(dims)) counts.set(v, (counts.get(v) ?? 0) + 1);
		}
		return [...counts.keys()].sort(
			(a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b),
		);
	};

	const decades = [...new Set(years.map((y) => Math.floor(y / 10) * 10))].sort((a, b) => a - b);

	// Label a theater by its name alone, falling back to the full "Name, City" when
	// two venues share a name — chips stay short without becoming ambiguous. The name
	// comes from the column, not from re-splitting the joined value: cities are
	// stored with their state ("New York, NY"), so the comma isn't a reliable seam.
	const venueValues = byFrequency((d) => d.venues);
	const nameCounts = new Map<string, number>();
	for (const v of venueValues) {
		const name = theaterNames.get(v) ?? v;
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	const venues = venueValues.map((value) => {
		const name = theaterNames.get(value) ?? value;
		return { value, label: (nameCounts.get(name) ?? 0) > 1 ? value : name };
	});

	return {
		decades,
		diaryYearLo,
		diaryYearHi,
		tags: byFrequency((d) => d.tags),
		friends: byFrequency((d) => d.friends),
		mediums: byFrequency((d) => d.mediums),
		venues,
		formats: byFrequency((d) => d.formats),
		directors: credits.directors,
		actors: credits.actors,
		genres: credits.genres,
		languages: credits.languages,
		countries: credits.countries,
	};
}

/**
 * The film-level facet values across all watched films — directors, top-billed cast,
 * genres, original languages and production countries — each ranked by how many films
 * carry them (most first, ties alphabetical). These feed the People / Genre / Language
 * / Country filter chips.
 *
 * Read film-level from the cached `movies` credit arrays (migrations 0008/0009), not
 * the diary, so a film seen once still offers its whole cast. Steps down through the
 * migration tiers (0009 → 0008 → base) so it keeps working whichever migrations are
 * applied: before a tier lands, the sections that depend on its columns simply come
 * back empty rather than erroring — matching how every other facet degrades.
 */
async function watchedFilmFacetFrequency(): Promise<{
	directors: string[];
	actors: string[];
	genres: string[];
	languages: string[];
	countries: string[];
}> {
	const PAGE = 1000;
	const tiers = [
		'movies!inner(directors, actors, genres, countries, original_language)', // 0009
		'movies!inner(directors, actors, genres, countries)', // 0008
	];
	const dirCounts = new Map<string, number>();
	const actCounts = new Map<string, number>();
	const genreCounts = new Map<string, number>();
	const langCounts = new Map<string, number>();
	const countryCounts = new Map<string, number>();
	const bump = (counts: Map<string, number>, v: string | null | undefined) => {
		if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
	};

	let tier = 0;
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select(tiers[tier])
			.range(offset, offset + PAGE - 1);
		if (error) {
			// original_language (0009) not there yet: drop a tier and restart from the top.
			if (tier < tiers.length - 1 && isMissingCreditColumn(error)) {
				tier++;
				offset = -PAGE; // next iteration resumes at offset 0
				for (const c of [dirCounts, actCounts, genreCounts, langCounts, countryCounts]) c.clear();
				continue;
			}
			if (isMissingCreditColumn(error) || isMissingRelation(error)) {
				return { directors: [], actors: [], genres: [], languages: [], countries: [] };
			}
			throw new Error(`watchedFilmFacetFrequency failed: ${error.message}`);
		}
		const rows = (data ?? []) as unknown as {
			movies: {
				directors: string[] | null;
				actors: string[] | null;
				genres: string[] | null;
				countries: string[] | null;
				original_language?: string | null;
			};
		}[];
		for (const r of rows) {
			for (const d of r.movies.directors ?? []) bump(dirCounts, d);
			for (const a of r.movies.actors ?? []) bump(actCounts, a);
			for (const g of r.movies.genres ?? []) bump(genreCounts, g);
			for (const c of r.movies.countries ?? []) bump(countryCounts, c);
			bump(langCounts, r.movies.original_language);
		}
		if (rows.length < PAGE) break;
	}
	const rank = (counts: Map<string, number>): string[] =>
		[...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
	return {
		directors: rank(dirCounts),
		actors: rank(actCounts),
		genres: rank(genreCounts),
		languages: rank(langCounts),
		countries: rank(countryCounts),
	};
}

/**
 * The set of calendar years each watched film was seen in, keyed by movie id — the
 * data behind the diary-date filter. A film watched across several years maps to each
 * of those years, which is what lets one film answer to more than one year in the
 * slider (seen in 2024 and 2026 → matches both).
 *
 * Years come from every live diary entry's `watched_date`, plus the film-level
 * `first_watched` so imported films with no dated diary entry still place on the
 * timeline. Degrades to an empty map before the tables exist, turning the diary-date
 * filter into a no-match rather than an error.
 */
async function loadDiaryYearsByMovie(): Promise<Map<number, Set<number>>> {
	const byMovie = new Map<number, Set<number>>();
	const add = (movieId: number, isoOrDate: string | null) => {
		if (!isoOrDate) return;
		const year = Number(isoOrDate.slice(0, 4));
		if (!Number.isFinite(year)) return;
		let set = byMovie.get(movieId);
		if (!set) {
			set = new Set();
			byMovie.set(movieId, set);
		}
		set.add(year);
	};

	const PAGE = 1000;
	// Dated diary entries — the primary source; one film contributes every year it
	// was logged in.
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('logs')
			.select('movie_id, watched_date')
			.is('deleted_at', null)
			.not('watched_date', 'is', null)
			.range(offset, offset + PAGE - 1);
		if (error) {
			if (isMissingRelation(error)) return byMovie;
			throw new Error(`loadDiaryYearsByMovie (logs) failed: ${error.message}`);
		}
		const rows = (data ?? []) as { movie_id: number; watched_date: string | null }[];
		for (const r of rows) add(r.movie_id, r.watched_date);
		if (rows.length < PAGE) break;
	}
	// Film-level first watch — covers imported films that never got a dated diary row.
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select('movie_id, first_watched')
			.not('first_watched', 'is', null)
			.range(offset, offset + PAGE - 1);
		if (error) {
			if (isMissingRelation(error)) break;
			throw new Error(`loadDiaryYearsByMovie (watched) failed: ${error.message}`);
		}
		const rows = (data ?? []) as { movie_id: number; first_watched: string | null }[];
		for (const r of rows) add(r.movie_id, r.first_watched);
		if (rows.length < PAGE) break;
	}
	return byMovie;
}

/**
 * The movie ids whose watch years intersect the query's diary-date range, or null when
 * the query sets no diary-date bound (i.e. "don't constrain by date"). An empty array
 * means nothing matched. A film is kept when ANY year it was watched falls in range.
 */
async function movieIdsMatchingDiaryYears(q: WatchedQuery): Promise<number[] | null> {
	if (q.diaryYearMin == null && q.diaryYearMax == null) return null;
	const lo = q.diaryYearMin ?? Number.NEGATIVE_INFINITY;
	const hi = q.diaryYearMax ?? Number.POSITIVE_INFINITY;
	const yearsByMovie = await loadDiaryYearsByMovie();
	const ids: number[] = [];
	for (const [movieId, years] of yearsByMovie) {
		for (const y of years) {
			if (y >= lo && y <= hi) {
				ids.push(movieId);
				break;
			}
		}
	}
	return ids;
}

/** "Name, City" → the bare theater name, for shortening the venue chip labels. */
async function theaterNameByValue(): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const { data, error } = await supabasePublic.from('theaters').select('name, city');
	if (error) {
		if (isMissingRelation(error)) return out;
		throw new Error(`theaterNameByValue failed: ${error.message}`);
	}
	for (const t of (data ?? []) as { name: string; city: string | null }[]) {
		out.set([t.name, t.city].filter(Boolean).join(', '), t.name);
	}
	return out;
}

/** Release years of every watched film (with one), for the decade chips. */
async function listWatchedReleaseYears(): Promise<number[]> {
	const PAGE = 1000;
	const out: number[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('watched')
			.select('movies!inner(release_year)')
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(`listWatchedReleaseYears failed: ${error.message}`);
		const rows = (data ?? []) as unknown as { movies: { release_year: number | null } }[];
		for (const r of rows) if (r.movies.release_year != null) out.push(r.movies.release_year);
		if (rows.length < PAGE) break;
	}
	return out;
}

/**
 * A Postgres `text[]` array literal with every element double-quoted and escaped —
 * for the `ov`/`cs` filters, whose values PostgREST passes through verbatim. Quoting
 * each element keeps names with commas, spaces or braces (a "{" in a title) from
 * being misread as array syntax.
 */
function pgTextArray(values: string[]): string {
	const escaped = values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
	return `{${escaped.join(',')}}`;
}

/**
 * One page of watched films for the "All films" grid at /films/watched.
 *
 * Filtering and sorting are done here rather than in the browser: the page only
 * ever holds a slice, so a client-side filter would search whatever happened to
 * be loaded instead of the whole collection.
 *
 * `id` breaks ties last so the total order is deterministic. Both sorts have huge
 * tie groups — every Letterboxd-imported film has a null first_watched, and a
 * release year is shared by dozens of films — and without a unique tiebreaker
 * Postgres may order tied rows differently between two paged queries, which shows
 * up as a film appearing twice while another never loads.
 */
export async function listWatchedPage(query: WatchedQuery = {}): Promise<WatchedPage> {
	const { q = '', sort = 'recent', limit = 100, offset = 0 } = query;

	// Resolve the diary-side filters first: they each narrow to a set of movie ids the
	// film-level query can be constrained by. An empty (not null) set means nothing
	// matched, and no film-level query could rescue it. The log-level filters (tags,
	// friends, medium…) and the diary-date range are two independent id sets; when
	// both are present the film has to be in both.
	const [logMovieIds, diaryYearIds] = await Promise.all([
		movieIdsMatchingLogFilters(query),
		movieIdsMatchingDiaryYears(query),
	]);
	if (logMovieIds?.length === 0 || diaryYearIds?.length === 0) return { films: [], total: 0 };
	let restrictIds: number[] | null;
	if (logMovieIds && diaryYearIds) {
		const keep = new Set(diaryYearIds);
		restrictIds = logMovieIds.filter((id) => keep.has(id));
		if (restrictIds.length === 0) return { films: [], total: 0 };
	} else {
		restrictIds = logMovieIds ?? diaryYearIds;
	}

	let req = supabasePublic
		.from('watched')
		.select('id, first_watched, rating, movies!inner(tmdb_id, title, release_year, poster_path)', {
			count: 'exact',
		});

	if (restrictIds) req = req.in('movie_id', restrictIds);

	const term = q.trim();
	// Escape the LIKE wildcards so a literal % or _ in a title search stays literal.
	if (term) req = req.ilike('movies.title', `%${term.replace(/[%_]/g, '\\$&')}%`);

	// Rating. Postgres comparisons are false for NULL, so a narrowed range already
	// drops unrated films — no explicit `not is null` needed.
	if (query.unratedOnly) {
		req = req.is('rating', null);
	} else {
		if (query.ratingMin != null) req = req.gte('rating', query.ratingMin);
		if (query.ratingMax != null) req = req.lte('rating', query.ratingMax);
	}
	if (query.liked) req = req.eq('liked', true);

	// Decades OR together as year ranges against the joined movie row. `!inner`
	// above is what makes a filter on the embed exclude the parent watched row.
	if (query.decades?.length) {
		const ranges = query.decades
			.map((d) => `and(release_year.gte.${d},release_year.lte.${d + 9})`)
			.join(',');
		req = req.or(ranges, { referencedTable: 'movies' });
	}

	// Exact release years — a single year rather than a decade span (the Stats
	// "Films by release year" bars deep-link here). ANDs with the decade filter
	// above when both are present, though the UI only ever sends one.
	if (query.releaseYears?.length) {
		req = req.in('movies.release_year', query.releaseYears);
	}

	// Director / cast: film-level array columns on the joined movie. `ov` (overlap)
	// keeps a film whose credit list shares any selected name — the design's "any"
	// semantics. Director and cast AND together (two filters), so picking one of each
	// narrows to films matching both. Built as a quoted Postgres array literal so
	// names with commas or punctuation survive the round-trip.
	if (query.directors?.length) {
		req = req.filter('movies.directors', 'ov', pgTextArray(query.directors));
	}
	if (query.actors?.length) {
		req = req.filter('movies.actors', 'ov', pgTextArray(query.actors));
	}

	// Genre and country are film-level array columns matched like the credits above —
	// `ov` (overlap) keeps a film sharing any selected value ("any" semantics). Language
	// is a scalar (`original_language`), so it matches with `in`. Each is ANDed with the
	// others, so picking a genre and a country narrows to films that are both.
	if (query.genres?.length) {
		req = req.filter('movies.genres', 'ov', pgTextArray(query.genres));
	}
	if (query.countries?.length) {
		req = req.filter('movies.countries', 'ov', pgTextArray(query.countries));
	}
	if (query.languages?.length) {
		req = req.in('movies.original_language', query.languages);
	}

	// "Year" is year-descending with the recent order inside each year; "Recent" is
	// newest-watched first. Undated/yearless films sort last either way.
	// Note the movies(release_year) spelling: it orders the watched rows by the
	// joined column. The `referencedTable` option instead sorts rows *within* each
	// embed, which for a to-one join is a silent no-op that leaves the order as-is.
	if (sort === 'year') {
		req = req.order('movies(release_year)', { ascending: false, nullsFirst: false });
	}
	req = req
		.order('first_watched', { ascending: false, nullsFirst: false })
		.order('id', { ascending: false });

	const { data, error, count } = await req.range(offset, offset + limit - 1);
	if (error) throw new Error(`listWatchedPage failed: ${error.message}`);

	const films = ((data ?? []) as unknown as {
		first_watched: string | null;
		rating: number | null;
		movies: WatchlistTile;
	}[]).map((r) => ({ ...r.movies, first_watched: r.first_watched, rating: r.rating }));
	return { films, total: count ?? 0 };
}

// --- Favorites (migration 0006) ---

/**
 * Search your WATCHED films by title — favorites can only be chosen from films
 * you've actually seen. Case-insensitive substring match, most-recently-watched
 * first. (Does not touch the `favorite` column, so it works pre-migration.)
 */
export async function searchWatchedMovies(query: string, limit = 12): Promise<WatchlistTile[]> {
	if (!query.trim()) return [];
	const { films } = await listWatchedPage({ q: query, sort: 'recent', limit });
	return films.map(({ first_watched: _first, ...tile }) => tile);
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
	/** The release year this bar stands for — set only on the "Films by release
	 * year" bars, so each can deep-link to that year's films. */
	year?: number;
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
	/** Null when the first watch is unknown (migration 0011) — such films count in
	 * all-time totals but can't be attributed to any calendar year. */
	first_watched: string | null;
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
			.order('first_watched', { ascending: false, nullsFirst: false })
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
			first_watched: string | null;
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

/** Year (local) of an ISO timestamp; null when the timestamp is unknown. */
function yearOf(iso: string | null): number | null {
	return iso ? new Date(iso).getFullYear() : null;
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

	// Picker options: years with a meaningful sample, newest first. Undated films
	// (unknown first watch) belong to no year, so they only reach the 'all' scope.
	const perYear = new Map<number, number>();
	for (const r of all) {
		const y = yearOf(r.first_watched);
		if (y != null) perYear.set(y, (perYear.get(y) ?? 0) + 1);
	}
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
	const thisYearCount = perYear.get(thisYear) ?? 0;
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
			if (!r.first_watched) continue; // year scope already excludes these; keeps the cast honest
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
				byYear.push({ count: c, year: y, title: `${y} · ${c} ${c === 1 ? 'film' : 'films'}` });
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
