// Service layer that sits between the API routes and Supabase/TMDB.
// Endpoints stay thin; the "check cache → maybe fetch TMDB → write" logic lives
// here so it's written once.
import { supabaseAdmin, supabasePublic } from './supabase';
import { siteDay, siteYear } from './day';
import { monthOf, shiftMonth, type MonthWatch } from './month-view';
import {
	extractCreditFacts,
	getMovieDetails,
	preferredReleaseDate,
	premiereDate,
	releaseYear,
} from './tmdb';

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
	// Two dates, two jobs. `release_date` is the first US opening (preferredReleaseDate,
	// which ignores re-releases) — the availability date the Watchlist's upcoming badge
	// needs. `release_year` is the widely-accepted release year, taken from the premiere
	// (earliest release anywhere) — the year the site sorts and displays by, and the same
	// year YTS files a film under. The two can straddle a New Year; that's intended.
	const releasedOn = preferredReleaseDate(d);
	const premieredOn = premiereDate(d);
	const now = new Date().toISOString();
	const base = {
		tmdb_id: d.id,
		title: d.title,
		release_year: releaseYear(premieredOn),
		poster_path: d.poster_path,
		backdrop_path: d.backdrop_path,
		overview: d.overview,
		runtime: d.runtime,
		last_synced_at: now,
	};
	// Genre + credit facts for the Stats page (migration 0008), the full release
	// date the Watchlist's upcoming badge needs (0014), and the premiere date the
	// film page's YTS search is keyed on (0019). The backfill fills these in
	// bulk for existing films; this keeps them fresh for anything logged from now
	// on. If those migrations haven't been applied yet, fall back to the base
	// columns so caching a movie still works.
	const withFacts = {
		...base,
		release_date: releasedOn,
		premiere_date: premieredOn,
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
	/**
	 * The diary date — the day the entry is being made, as "YYYY-MM-DD" on the
	 * client's own calendar. Sent by the composer because only the browser knows
	 * what day it is where the user is; falls back to the day in SITE_TZ.
	 */
	loggedDate?: string | null;
	rating?: number | null; // 0.5–5.0 in half-steps
	reviewText?: string | null;
	/** Owner-only note. Never rendered to a visitor — see migration 0052. */
	privateNote?: string | null;
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
	/** Owner-only note; null clears it. */
	privateNote?: string | null;
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
async function markWatched(movie: MovieRow, watchedDate: string | null, today: string): Promise<void> {
	// Undated entries fall back to the day it is for the user, not the instant in
	// UTC — `first_watched` is read as a calendar day (year buckets, "first seen").
	const firstWatched = `${watchedDate ?? today}T00:00:00Z`;
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
		// A note nobody else will read is still a reason for the entry to exist.
		(typeof input.privateNote === 'string' && input.privateNote.trim().length > 0) ||
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
	// The day this entry is being made. The client's own, when it sent one; the
	// site's zone otherwise — never UTC's, which turns over mid-evening here.
	const today = input.loggedDate ?? siteDay();
	await markWatched(movie, input.watchedDate ?? null, today);
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

	const { data: log, error } = await supabaseAdmin
		.from('logs')
		.insert({
			movie_id: movie.id,
			watched_date: input.watchedDate ?? null,
			log: today, // diary date — when the entry was made
			rating: input.rating ?? null,
			review_text: input.reviewText ?? null,
			private_note: input.privateNote ?? null,
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
	if ('privateNote' in input) patch.private_note = input.privateNote ?? null;
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
 * Every watch in one "YYYY-MM" month, for the share card.
 *
 * Reads `logs` rather than the `logs_with_movie` view because the card needs
 * `runtime`, which the view doesn't carry (CREATE OR REPLACE VIEW can only
 * append columns, and this is the only caller that wants it). Rows with no
 * `watched_date` are excluded rather than falling back to `created_at` the way
 * the diary list does — a watch with no day has no cell to sit in.
 */
export async function listMonthWatches(key: string): Promise<MonthWatch[]> {
	const { data, error } = await supabasePublic
		.from('logs')
		.select(
			'id, watched_date, rating, liked, rewatched, created_at, medium, ' +
				'movies(tmdb_id, title, release_year, poster_path, runtime)',
		)
		.gte('watched_date', `${key}-01`)
		.lt('watched_date', `${shiftMonth(key, 1)}-01`)
		.is('deleted_at', null)
		.order('watched_date', { ascending: true })
		.order('created_at', { ascending: true })
		.order('id', { ascending: true });
	if (error) throw new Error(`listMonthWatches failed: ${error.message}`);

	const rows = (data ?? []) as unknown as {
		id: number;
		watched_date: string;
		rating: number | null;
		liked: boolean;
		rewatched: boolean;
		created_at: string;
		medium: string | null;
		movies: {
			tmdb_id: number;
			title: string;
			release_year: number | null;
			poster_path: string | null;
			runtime: number | null;
		} | null;
	}[];

	// A log always has a movie (movie_id is not null), but the embed is typed as
	// nullable — drop anything that came back without one rather than render a
	// blank print.
	return rows.flatMap((row) =>
		row.movies
			? [
					{
						id: row.id,
						watched_date: row.watched_date,
						rating: row.rating,
						liked: row.liked,
						rewatched: row.rewatched,
						created_at: row.created_at,
						medium: row.medium,
						tmdb_id: row.movies.tmdb_id,
						title: row.movies.title,
						release_year: row.movies.release_year,
						poster_path: row.movies.poster_path,
						runtime: row.movies.runtime,
					},
				]
			: [],
	);
}

/**
 * Watches per "YYYY-MM", for the month picker's counts. Pages explicitly because
 * PostgREST caps an unbounded select at 1000 rows, which a few years of diary
 * would quietly exceed — and a truncated count reads as "no films that month".
 */
export async function countWatchesByMonth(): Promise<Record<string, number>> {
	const PAGE = 1000;
	const counts: Record<string, number> = {};
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('logs')
			.select('watched_date')
			.not('watched_date', 'is', null)
			.is('deleted_at', null)
			.order('watched_date', { ascending: true })
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(`countWatchesByMonth failed: ${error.message}`);
		const rows = (data ?? []) as { watched_date: string }[];
		for (const row of rows) {
			const key = monthOf(row.watched_date);
			counts[key] = (counts[key] ?? 0) + 1;
		}
		if (rows.length < PAGE) return counts;
	}
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
	/**
	 * The owner's private note, or null. Null for BOTH "there is no note" and
	 * "you are not the owner" — getDiaryEntry doesn't select the column unless
	 * asked to, so a visitor's copy of this entry never held the text at all.
	 */
	private_note: string | null;
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
 *
 * `includePrivate` is the owner check, and it defaults to false so a caller that
 * forgets it gets the safe answer: the private note is not merely hidden by the
 * template, it is never selected, so it never reaches the process rendering the
 * page. Pass `await requireOwner(cookies)` and nothing else.
 */
export async function getDiaryEntry(
	id: number,
	includePrivate = false,
): Promise<DiaryEntry | null> {
	const BASE =
		'id, watched_date, rating, review_text, rewatched, liked, created_at, ' +
		(includePrivate ? 'private_note, ' : '') +
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
	// Same graceful step-down as the tiers above, for the newest column: a
	// database that predates 0052 renders the page without the note rather than
	// 500ing on it.
	if (lastError && includePrivate && isMissingCreditColumn(lastError)) return getDiaryEntry(id, false);
	if (lastError) throw new Error(`getDiaryEntry failed: ${lastError.message}`);
	if (!data) return null;

	const row = data as {
		id: number;
		watched_date: string | null;
		rating: number | null;
		review_text: string | null;
		private_note?: string | null;
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
		private_note: row.private_note ?? null,
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
		/** Full release date, "YYYY-MM-DD" (0014); null when TMDB has no date. The
		 * film page's meta row shows it in full, where the year alone appears
		 * beside the title. */
		release_date: string | null;
		/** Premiere date — earliest release anywhere, "YYYY-MM-DD" (0019); null when
		 * TMDB has no date or the column isn't populated yet. Nothing on the page
		 * displays it; it's the year the YTS search has to use. */
		premiere_date: string | null;
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
	const CORE =
		'id, tmdb_id, title, release_year, release_date, poster_path, backdrop_path, overview, runtime';
	const W = 'watched(rating, liked, first_watched)';
	// Two independent migration dimensions: the premiere date (0019) and the credit
	// columns (0008/0009). Walk the credit tiers with premiere_date, then walk them
	// again without it, so a missing 0019 costs the premiere date rather than the
	// credits.
	const tiers = [`${CORE}, premiere_date`, CORE].flatMap((base) => [
		`${base}, genres, directors, actors, countries, original_language, mpa_rating, ${W}`, // 0008+0009
		`${base}, genres, directors, actors, countries, ${W}`, // 0008 only
		`${base}, ${W}`, // pre-0008
	]);

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

	const {
		watched,
		genres,
		directors,
		actors,
		countries,
		original_language,
		mpa_rating,
		premiere_date,
		...rest
	} = data as Omit<
		FilmByTmdb['movie'],
		| 'genres'
		| 'directors'
		| 'actors'
		| 'countries'
		| 'original_language'
		| 'mpa_rating'
		| 'premiere_date'
	> & {
		genres?: string[] | null;
		directors?: string[] | null;
		actors?: string[] | null;
		countries?: string[] | null;
		original_language?: string | null;
		mpa_rating?: string | null;
		premiere_date?: string | null;
		watched: WatchedActivity[] | WatchedActivity | null;
	};
	const w = Array.isArray(watched) ? (watched[0] ?? null) : (watched ?? null);
	return {
		movie: {
			...rest,
			premiere_date: premiere_date ?? null,
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

/** Whether a film is currently on the watchlist — the unwatched film page's toggle
 * starts from this. */
export async function isOnWatchlist(movieId: number): Promise<boolean> {
	const { data, error } = await supabasePublic
		.from('watchlist')
		.select('id')
		.eq('movie_id', movieId)
		.maybeSingle();
	if (error) throw new Error(`isOnWatchlist failed: ${error.message}`);
	return !!data;
}

/** A film you've watched, offered as a way into a film you haven't. */
export interface RelatedFilm extends WatchlistTile {
	/** The director both films share, when that's why this one is here; null for a
	 * genre match. Drives the tile's caption. */
	sharedDirector: string | null;
}

/**
 * Films you've already watched that this (unwatched) one might send you back to —
 * the "If you liked" strip on the film page.
 *
 * Same director first, since that's the strongest signal and the one worth saying
 * out loud, then films sharing genres ranked by how many they share and how highly
 * you rated them. Only ever returns films from your own `watched` set, so every
 * tile links to a page that exists. Returns [] when the credit columns (0008)
 * aren't there yet, or when the film has no directors or genres cached.
 */
export async function listRelatedWatched(
	film: { tmdb_id: number; directors: string[]; genres: string[] },
	limit = 4,
): Promise<RelatedFilm[]> {
	const { tmdb_id, directors, genres } = film;
	if (directors.length === 0 && genres.length === 0) return [];

	const SELECT = 'rating, movies!inner(tmdb_id, title, release_year, poster_path, genres, directors)';
	type Row = {
		rating: number | null;
		movies: WatchlistTile & { genres: string[] | null; directors: string[] | null };
	};

	// Best-rated first, unrated last — the order both pools are drawn in.
	const pool = async (column: 'directors' | 'genres', values: string[], take: number) => {
		if (values.length === 0) return [] as Row[];
		const res = await supabasePublic
			.from('watched')
			.select(SELECT)
			.filter(`movies.${column}`, 'ov', pgTextArray(values))
			.order('rating', { ascending: false, nullsFirst: false })
			.limit(take);
		// Pre-0008 there are no credit columns to match on — no related films, not an error.
		if (res.error) {
			if (isMissingCreditColumn(res.error)) return [] as Row[];
			throw new Error(`listRelatedWatched failed: ${res.error.message}`);
		}
		return (res.data ?? []) as unknown as Row[];
	};

	// The genre pool is drawn wide because it gets re-ranked below; the director pool
	// is already in its final order, so it only needs enough to fill the strip.
	const [byDirector, byGenre] = await Promise.all([
		pool('directors', directors, limit + 1),
		pool('genres', genres, 60),
	]);

	const wanted = new Set(genres);
	const shared = (r: Row) => (r.movies.genres ?? []).filter((g) => wanted.has(g)).length;
	// More shared genres wins; the pool already arrived rating-ordered, so a stable
	// sort keeps rating as the tiebreak.
	const ranked = byGenre.slice().sort((a, b) => shared(b) - shared(a));

	const out: RelatedFilm[] = [];
	const seen = new Set<number>([tmdb_id]);
	for (const [rows, isDirectorMatch] of [
		[byDirector, true],
		[ranked, false],
	] as const) {
		for (const r of rows) {
			if (out.length === limit) return out;
			const m = r.movies;
			if (seen.has(m.tmdb_id)) continue;
			seen.add(m.tmdb_id);
			out.push({
				tmdb_id: m.tmdb_id,
				title: m.title,
				release_year: m.release_year,
				poster_path: m.poster_path,
				sharedDirector: isDirectorMatch
					? ((m.directors ?? []).find((d) => directors.includes(d)) ?? null)
					: null,
			});
		}
	}
	return out;
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
	const year = siteYear();
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

/** A watchlist entry as the page's tiles render it — everything a tile draws, and
 * nothing a filter reads. The filterable facts are a separate, deferred read; see
 * listWatchlistFacets. */
export interface WatchlistEntry extends WatchlistTile {
	added_at: string;
	/** Full release date, "YYYY-MM-DD" (0014). Null when TMDB has no date — which
	 * for a watchlist is usually an announced film with nothing but a title. */
	release_date: string | null;
}

/** The entire watchlist, most recently added first — powers /films/watchlist.
 * Unpaged: the page filters and sorts the whole list in the browser, so it has to
 * ship all of it. Fine at a few hundred films; revisit if it reaches thousands.
 *
 * Deliberately narrow. Each film's genres, directors and cast are arrays that
 * roughly double the response and, rendered as per-tile data attributes, more than
 * double the page — for values nothing on screen reads until the filter panel is
 * opened. listWatchlistFacets carries those separately. */
export async function listAllWatchlist(): Promise<WatchlistEntry[]> {
	const { data, error } = await supabasePublic
		.from('watchlist')
		.select('added_at, movies(tmdb_id, title, release_year, release_date, poster_path)')
		.order('added_at', { ascending: false });
	if (error) throw new Error(`listAllWatchlist failed: ${error.message}`);

	type Row = {
		added_at: string;
		movies: {
			tmdb_id: number;
			title: string;
			release_year: number | null;
			release_date: string | null;
			poster_path: string | null;
		};
	};
	return ((data ?? []) as unknown as Row[]).map((r) => ({
		tmdb_id: r.movies.tmdb_id,
		title: r.movies.title,
		release_year: r.movies.release_year,
		release_date: r.movies.release_date,
		poster_path: r.movies.poster_path,
		added_at: r.added_at,
	}));
}

/** The filterable facts about one watchlist film, keyed to its tile by TMDB id. */
export interface WatchlistFacetRow {
	tmdb_id: number;
	/** Cached TMDB genres (migration 0008); [] when never synced. */
	genres: string[];
	/** Directors (migration 0008); [] when never synced — the "People → Director" chips. */
	directors: string[];
	/** Top-billed cast (migration 0008); [] when never synced — the "People → Cast" chips. */
	actors: string[];
	/** Original language as an English name (migration 0009); null until backfilled. */
	language: string | null;
}

/**
 * Every watchlist film's genres, credits and language — what the Genre / Language /
 * People filters match on, and what their chips are derived from.
 *
 * Split out of listAllWatchlist so the page can render its tiles without waiting on
 * it, then fill the filters in afterwards. Steps down a tier when original_language
 * (0009) isn't there yet, so Language / People come back empty rather than erroring
 * before the migration lands.
 */
export async function listWatchlistFacets(): Promise<WatchlistFacetRow[]> {
	const tiers = [
		'movies(tmdb_id, genres, directors, actors, original_language)', // 0008 + 0009
		'movies(tmdb_id, genres, directors, actors)', // 0008 only
	];

	let data: unknown = null;
	let lastError: PgError | null = null;
	for (const select of tiers) {
		const res = await supabasePublic.from('watchlist').select(select);
		if (!res.error) {
			data = res.data;
			lastError = null;
			break;
		}
		lastError = res.error;
		if (!isMissingCreditColumn(res.error)) break; // a real error — stop stepping down
	}
	if (lastError) throw new Error(`listWatchlistFacets failed: ${lastError.message}`);

	type Row = {
		movies: {
			tmdb_id: number;
			genres: string[] | null;
			directors?: string[] | null;
			actors?: string[] | null;
			original_language?: string | null;
		};
	};
	return ((data ?? []) as unknown as Row[]).map((r) => ({
		tmdb_id: r.movies.tmdb_id,
		genres: r.movies.genres ?? [],
		directors: r.movies.directors ?? [],
		actors: r.movies.actors ?? [],
		language: r.movies.original_language ?? null,
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
	/** Inclusive release-year bounds, e.g. 1994–2003. Films with no release year fall
	 * outside any bound, so a narrowed range drops them. Omit both for "any year". */
	releaseYearMin?: number;
	releaseYearMax?: number;
	/** Exact release years, e.g. [2019]. Matches any of them. Narrower than the bounds
	 * above — the Stats "Films by release year" bars link here. ANDs with them when
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
 * Every list is ordered by how many films carry the value, most first, ties
 * alphabetical.
 */
export interface WatchedFacets {
	/** Earliest / latest year anything in the collection was released — the
	 * release-date slider's end stops. Null when nothing carries a release year. */
	releaseYearLo: number | null;
	releaseYearHi: number | null;
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
export async function listWatchedFacets(isOwner = false): Promise<WatchedFacets> {
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

	// End stops for the release-date slider, straight off the collection's own years.
	const releaseYearsAsc = [...new Set(years)].sort((a, b) => a - b);
	const releaseYearLo = releaseYearsAsc[0] ?? null;
	const releaseYearHi = releaseYearsAsc[releaseYearsAsc.length - 1] ?? null;

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
		releaseYearLo,
		releaseYearHi,
		diaryYearLo,
		diaryYearHi,
		tags: byFrequency((d) => d.tags),
		// Friends are owner-only across the site; a visitor gets no chips (and the
		// panel hides the whole "Watched with" section).
		friends: isOwner ? byFrequency((d) => d.friends) : [],
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

/** A PostgREST error as the migration-tier checks above read it. */
type PgError = { code?: string; message?: string };

/** One page of a paged read: whatever `.range().select()` came back with. */
interface PageResult<T> {
	data: T[] | null;
	error: PgError | null;
	count?: number | null;
}

/** PostgREST caps a response at 1000 rows, so anything larger has to be paged. */
const PAGE = 1000;

/**
 * Read every row a query matches, fetching the pages concurrently.
 *
 * Walking pages in a loop costs one round trip per thousand rows against a
 * database that's a continent away — and at ~150ms each that's most of what the
 * facet reads spend. Asking the first page for the exact count says up front how
 * many more there are, which is enough to fire all of them at once: two round
 * trips for any collection size rather than one per page.
 *
 * `fetchPage` runs a single range query; `wantCount` is true only for the first,
 * since the count is the same on every page and isn't free. Errors come back
 * rather than throwing, so callers keep their own migration-tier fallbacks.
 */
async function readAllPages<T>(
	fetchPage: (from: number, to: number, wantCount: boolean) => PromiseLike<PageResult<T>>,
): Promise<{ rows: T[]; error: PgError | null }> {
	const first = await fetchPage(0, PAGE - 1, true);
	if (first.error) return { rows: [], error: first.error };

	const rows = (first.data ?? []) as T[];
	// A short first page is the whole result — no count needed to know that. When
	// the count is missing (a view that can't be counted) the short page is still
	// the signal, and we simply stop here.
	const total = first.count ?? rows.length;
	if (rows.length < PAGE || total <= PAGE) return { rows, error: null };

	const rest: PromiseLike<PageResult<T>>[] = [];
	for (let from = PAGE; from < total; from += PAGE) rest.push(fetchPage(from, from + PAGE - 1, false));
	for (const page of await Promise.all(rest)) {
		if (page.error) return { rows: [], error: page.error };
		rows.push(...((page.data ?? []) as T[]));
	}
	return { rows, error: null };
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
	const tiers = [
		'movies!inner(directors, actors, genres, countries, original_language)', // 0009
		'movies!inner(directors, actors, genres, countries)', // 0008
	];
	type Row = {
		movies: {
			directors: string[] | null;
			actors: string[] | null;
			genres: string[] | null;
			countries: string[] | null;
			original_language?: string | null;
		};
	};

	// Try the richest column set first, dropping a tier if original_language (0009)
	// isn't there yet. Each tier is a fresh whole-collection read, so nothing has to
	// be un-counted on the way down.
	let rows: Row[] = [];
	for (const [i, cols] of tiers.entries()) {
		const res = await readAllPages<Row>((from, to, wantCount) =>
			supabasePublic
				.from('watched')
				.select(cols, wantCount ? { count: 'exact' } : undefined)
				.range(from, to) as unknown as PromiseLike<PageResult<Row>>,
		);
		if (!res.error) {
			rows = res.rows;
			break;
		}
		if (i < tiers.length - 1 && isMissingCreditColumn(res.error)) continue;
		if (isMissingCreditColumn(res.error) || isMissingRelation(res.error)) {
			return { directors: [], actors: [], genres: [], languages: [], countries: [] };
		}
		throw new Error(`watchedFilmFacetFrequency failed: ${res.error.message}`);
	}

	const dirCounts = new Map<string, number>();
	const actCounts = new Map<string, number>();
	const genreCounts = new Map<string, number>();
	const langCounts = new Map<string, number>();
	const countryCounts = new Map<string, number>();
	const bump = (counts: Map<string, number>, v: string | null | undefined) => {
		if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
	};
	for (const r of rows) {
		for (const d of r.movies.directors ?? []) bump(dirCounts, d);
		for (const a of r.movies.actors ?? []) bump(actCounts, a);
		for (const g of r.movies.genres ?? []) bump(genreCounts, g);
		for (const c of r.movies.countries ?? []) bump(countryCounts, c);
		bump(langCounts, r.movies.original_language);
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

	// Dated diary entries — the primary source; one film contributes every year it
	// was logged in. Film-level first watches cover imported films that never got a
	// dated diary row. The two are independent reads, so they go out together.
	type LogRow = { movie_id: number; watched_date: string | null };
	type WatchedRow = { movie_id: number; first_watched: string | null };
	const [logs, watched] = await Promise.all([
		readAllPages<LogRow>((from, to, wantCount) =>
			supabasePublic
				.from('logs')
				.select('movie_id, watched_date', wantCount ? { count: 'exact' } : undefined)
				.is('deleted_at', null)
				.not('watched_date', 'is', null)
				.range(from, to) as unknown as PromiseLike<PageResult<LogRow>>,
		),
		readAllPages<WatchedRow>((from, to, wantCount) =>
			supabasePublic
				.from('watched')
				.select('movie_id, first_watched', wantCount ? { count: 'exact' } : undefined)
				.not('first_watched', 'is', null)
				.range(from, to) as unknown as PromiseLike<PageResult<WatchedRow>>,
		),
	]);

	if (logs.error) {
		if (isMissingRelation(logs.error)) return byMovie;
		throw new Error(`loadDiaryYearsByMovie (logs) failed: ${logs.error.message}`);
	}
	for (const r of logs.rows) add(r.movie_id, r.watched_date);

	// A missing `watched` table only costs the imported films their year; the diary
	// entries already read are still worth returning.
	if (watched.error && !isMissingRelation(watched.error)) {
		throw new Error(`loadDiaryYearsByMovie (watched) failed: ${watched.error.message}`);
	}
	for (const r of watched.rows) add(r.movie_id, r.first_watched);
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

/** Release years of every watched film (with one), for the release-date slider. */
async function listWatchedReleaseYears(): Promise<number[]> {
	type Row = { movies: { release_year: number | null } };
	const { rows, error } = await readAllPages<Row>((from, to, wantCount) =>
		supabasePublic
			.from('watched')
			.select('movies!inner(release_year)', wantCount ? { count: 'exact' } : undefined)
			.range(from, to) as unknown as PromiseLike<PageResult<Row>>,
	);
	if (error) throw new Error(`listWatchedReleaseYears failed: ${error.message}`);
	const out: number[] = [];
	for (const r of rows) if (r.movies.release_year != null) out.push(r.movies.release_year);
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
 * How many distinct films are marked watched, ignoring every filter — the
 * "N films watched" the grid's header counts. A head request, so it costs a count
 * rather than a page of rows; only worth making when the page's own query is
 * filtered and its total therefore counts a slice.
 */
export async function countWatchedFilms(): Promise<number> {
	const { count, error } = await supabasePublic
		.from('watched')
		.select('*', { count: 'exact', head: true });
	if (error) throw new Error(`countWatchedFilms failed: ${error.message}`);
	return count ?? 0;
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
export async function listWatchedPage(query: WatchedQuery = {}, isOwner = false): Promise<WatchedPage> {
	// Friends are owner-only, so a visitor's `?friend=…` can't be used to probe
	// which films were watched with whom — drop the filter before it's applied.
	if (!isOwner && query.friends?.length) query = { ...query, friends: [] };
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

	// Release-year bounds against the joined movie row. `!inner` above is what makes
	// a filter on the embed exclude the parent watched row; a film with a null
	// release_year fails either comparison, which is what drops the undated.
	if (query.releaseYearMin != null) req = req.gte('movies.release_year', query.releaseYearMin);
	if (query.releaseYearMax != null) req = req.lte('movies.release_year', query.releaseYearMax);

	// Exact release years — picked years rather than a span (the Stats "Films by
	// release year" bars deep-link here). ANDs with the bounds above when both are
	// present, though the UI only ever sends one.
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
	const tiers = [
		'movies!inner(release_year, runtime, genres, countries, directors, actors, original_language)', // 0009
		'movies!inner(release_year, runtime, genres, countries, directors, actors)', // 0008
		'movies!inner(release_year, runtime)', // pre-0008
	];
	type Row = {
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
	};

	// Each tier is a fresh whole-collection read, so dropping to the next one never
	// has to un-accumulate what the last attempt got.
	let rows: Row[] = [];
	for (const [i, cols] of tiers.entries()) {
		const res = await readAllPages<Row>((from, to, wantCount) =>
			supabasePublic
				.from('watched')
				.select(`first_watched, rating, ${cols}`, wantCount ? { count: 'exact' } : undefined)
				.order('first_watched', { ascending: false, nullsFirst: false })
				.range(from, to) as unknown as PromiseLike<PageResult<Row>>,
		);
		if (!res.error) {
			rows = res.rows;
			break;
		}
		// Columns not there yet: drop to the next tier.
		if (i < tiers.length - 1 && isMissingCreditColumn(res.error)) continue;
		throw new Error(`loadWatchedFacts failed: ${res.error.message}`);
	}

	return rows.map((r) => ({
		first_watched: r.first_watched,
		rating: r.rating,
		release_year: r.movies.release_year,
		runtime: r.movies.runtime,
		genres: r.movies.genres ?? [],
		countries: r.movies.countries ?? [],
		directors: r.movies.directors ?? [],
		actors: r.movies.actors ?? [],
		originalLanguage: r.movies.original_language ?? null,
	}));
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
	const thisYear = siteYear();
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
