// Server-only TMDB v3 client. The API key lives in env and never leaves the
// server — all TMDB traffic is proxied through our own /api/tmdb/* routes so the
// key can't be scraped from the client.

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Poster/backdrop sizes TMDB offers. Use w342/w500 for cards, original for hero backdrops. */
export type ImageSize =
	| 'w92'
	| 'w154'
	| 'w185'
	| 'w342'
	| 'w500'
	| 'w780'
	| 'original';

/**
 * Build a full image URL from a TMDB path fragment (e.g. "/abc.jpg").
 * Returns null when the path is null so callers can fall back to a placeholder.
 */
export function imageUrl(path: string | null | undefined, size: ImageSize = 'w342'): string | null {
	if (!path) return null;
	return `${IMAGE_BASE}/${size}${path}`;
}

function apiKey(): string {
	const key = import.meta.env.TMDB_API_KEY;
	if (!key) throw new Error('TMDB_API_KEY is not set');
	return key;
}

/** Low-level GET against the TMDB API. `params` are query-string values. */
async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
	const url = new URL(`${BASE}${path}`);
	url.searchParams.set('api_key', apiKey());
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new TmdbError(res.status, `TMDB ${path} failed: ${res.status} ${body}`);
	}
	return (await res.json()) as T;
}

export class TmdbError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = 'TmdbError';
	}
}

// --- Minimal typed shapes (only the fields we actually use) ---

export interface TmdbSearchResult {
	id: number;
	title: string;
	release_date: string; // "YYYY-MM-DD" or ""
	poster_path: string | null;
	overview: string;
}

export interface TmdbMovieDetails {
	id: number;
	title: string;
	release_date: string;
	poster_path: string | null;
	backdrop_path: string | null;
	overview: string;
	runtime: number | null;
	vote_average: number;
	vote_count: number;
	/** TMDB's original-language ISO-639-1 code, e.g. "en", "ja". */
	original_language?: string;
	genres: { id: number; name: string }[];
	spoken_languages?: { english_name?: string; iso_639_1: string; name: string }[];
	production_countries?: { iso_3166_1: string; name: string }[];
	credits?: {
		cast: { id: number; name: string; character: string; profile_path: string | null }[];
		crew: { id: number; name: string; job: string }[];
	};
	release_dates?: {
		results: {
			iso_3166_1: string;
			release_dates: { certification: string; release_date: string; type: number }[];
		}[];
	};
	videos?: { results: { key: string; site: string; type: string; name: string }[] };
	similar?: { results: TmdbSearchResult[] };
}

/** Genre + credit facts denormalized onto the movie cache row (migrations 0008 + 0009). */
export interface MovieCreditFacts {
	genres: string[];
	languages: string[];
	countries: string[];
	directors: string[];
	actors: string[];
	/** Original language as an English name, e.g. "Japanese" (null if unknown). */
	originalLanguage: string | null;
	/** US content rating, e.g. "PG-13" (null when TMDB has no US certification). */
	mpaRating: string | null;
}

/** How many billed cast members to keep per film for the "top actors" aggregate. */
const TOP_CAST = 10;

/** Fallback ISO-639-1 → English name for common languages not present in spoken_languages. */
const LANGUAGE_NAMES: Record<string, string> = {
	en: 'English', ja: 'Japanese', fr: 'French', ko: 'Korean', zh: 'Chinese',
	cn: 'Cantonese', es: 'Spanish', it: 'Italian', de: 'German', ru: 'Russian',
	hi: 'Hindi', pt: 'Portuguese', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
	fi: 'Finnish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', ar: 'Arabic',
	fa: 'Persian', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', he: 'Hebrew',
	cs: 'Czech', hu: 'Hungarian', el: 'Greek', ro: 'Romanian', uk: 'Ukrainian',
	ta: 'Tamil', te: 'Telugu', bn: 'Bengali', ml: 'Malayalam', mr: 'Marathi',
};

/** Resolve TMDB's original_language code to an English name, using the film's own
 * spoken_languages first (most accurate) and a common-language fallback map. */
function originalLanguageName(d: TmdbMovieDetails): string | null {
	const code = d.original_language;
	if (!code) return null;
	const spoken = (d.spoken_languages ?? []).find((l) => l.iso_639_1 === code);
	const name = spoken?.english_name || spoken?.name || LANGUAGE_NAMES[code];
	return name ?? code.toUpperCase();
}

/** The US content rating from TMDB release_dates: first non-empty US certification. */
function usCertification(d: TmdbMovieDetails): string | null {
	const us = (d.release_dates?.results ?? []).find((r) => r.iso_3166_1 === 'US');
	const cert = (us?.release_dates ?? []).map((r) => r.certification?.trim()).find((c) => c);
	return cert || null;
}

/**
 * Pull the flat name-lists the Stats page aggregates over out of a full TMDB
 * details+credits response. Cast is kept in billing order (TMDB returns it sorted
 * by `order`), truncated to the top {@link TOP_CAST}. De-duplicates within a film
 * (e.g. an actor credited twice) while preserving order.
 */
export function extractCreditFacts(d: TmdbMovieDetails): MovieCreditFacts {
	const uniq = (names: (string | null | undefined)[]): string[] => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of names) {
			const name = raw?.trim();
			if (name && !seen.has(name)) {
				seen.add(name);
				out.push(name);
			}
		}
		return out;
	};
	return {
		genres: uniq((d.genres ?? []).map((g) => g.name)),
		languages: uniq((d.spoken_languages ?? []).map((l) => l.english_name || l.name)),
		countries: uniq((d.production_countries ?? []).map((c) => c.name)),
		directors: uniq((d.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name)),
		actors: uniq((d.credits?.cast ?? []).slice(0, TOP_CAST).map((c) => c.name)),
		originalLanguage: originalLanguageName(d),
		mpaRating: usCertification(d),
	};
}

export interface TmdbPage<T> {
	page: number;
	results: T[];
	total_pages: number;
	total_results: number;
}

/** Search as the user types. Debounce on the client (~300ms) before calling. */
export function searchMovies(query: string, page = 1) {
	return tmdbGet<TmdbPage<TmdbSearchResult>>('/search/movie', {
		query,
		page: String(page),
		include_adult: 'false',
	});
}

/** Full details + cast + trailers + similar + release certs in ONE request. */
export function getMovieDetails(tmdbId: number) {
	return tmdbGet<TmdbMovieDetails>(`/movie/${tmdbId}`, {
		append_to_response: 'credits,videos,similar,release_dates',
	});
}

/** Streaming availability, keyed by country code. */
export function getWatchProviders(tmdbId: number) {
	return tmdbGet<{ results: Record<string, unknown> }>(`/movie/${tmdbId}/watch/providers`);
}

/** Trending movies this week — homepage widget. */
export function getTrending() {
	return tmdbGet<TmdbPage<TmdbSearchResult>>('/trending/movie/week');
}

/** Genre id→name list, for filter dropdowns. */
export function getGenres() {
	return tmdbGet<{ genres: { id: number; name: string }[] }>('/genre/movie/list');
}

/** Pull the 4-digit year out of a TMDB "YYYY-MM-DD" release_date, or null. */
export function releaseYear(releaseDate: string | null | undefined): number | null {
	if (!releaseDate) return null;
	const year = Number.parseInt(releaseDate.slice(0, 4), 10);
	return Number.isNaN(year) ? null : year;
}

/** A TMDB release_date as a "YYYY-MM-DD" date, or null. TMDB sends "" — not null
 * — for films with no known date, which Postgres rejects for a `date` column. */
export function releaseDate(date: string | null | undefined): string | null {
	return /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? (date as string) : null;
}

/**
 * TMDB release_dates `type` codes. We only care about the theatrical/premiere end
 * of the scale; digital/physical/TV releases (4/5/6) don't set a film's release.
 * https://developer.themoviedb.org/reference/movie-release-dates
 */
const RELEASE_TYPE = { PREMIERE: 1, THEATRICAL_LIMITED: 2, THEATRICAL: 3 } as const;

/** The calendar-date portion ("YYYY-MM-DD") of a per-country release_dates entry.
 * These carry a full ISO timestamp ("2023-07-21T00:00:00.000Z"); we keep the date
 * TMDB literally stated rather than parsing it through a timezone (which could
 * shift a midnight release onto the previous day). */
function releaseDatesDay(iso: string | null | undefined): string | null {
	return /^\d{4}-\d{2}-\d{2}/.test(iso ?? '') ? (iso as string).slice(0, 10) : null;
}

/**
 * The film's canonical release date, preferring the US theatrical release.
 *
 * TMDB's top-level `release_date` is the earliest release *anywhere* — often a
 * foreign festival premiere months before the film reached US audiences. For a
 * US-centric film log the meaningful date is the US theatrical one, so we read the
 * per-country release_dates (append_to_response=release_dates) and prefer, in order:
 *   1. US theatrical            (type 3)
 *   2. US theatrical (limited)  (type 2)
 *   3. US premiere              (type 1)
 *   4. earliest premiere anywhere — an international premiere (type 1)
 * falling back to TMDB's top-level release_date only when none of those exist.
 * Within a type the earliest date wins, so a later re-release can't override the
 * original run. Returns "YYYY-MM-DD" or null when TMDB has no usable date.
 */
export function preferredReleaseDate(d: TmdbMovieDetails): string | null {
	const results = d.release_dates?.results ?? [];
	const earliestOfType = (
		entries: { release_date: string; type: number }[],
		type: number,
	): string | null => {
		const days = entries
			.filter((e) => e.type === type)
			.map((e) => releaseDatesDay(e.release_date))
			.filter((day): day is string => day != null)
			.sort();
		return days[0] ?? null;
	};

	const us = results.find((r) => r.iso_3166_1 === 'US')?.release_dates ?? [];
	const usDate =
		earliestOfType(us, RELEASE_TYPE.THEATRICAL) ??
		earliestOfType(us, RELEASE_TYPE.THEATRICAL_LIMITED) ??
		earliestOfType(us, RELEASE_TYPE.PREMIERE);
	if (usDate) return usDate;

	const premiere = earliestOfType(
		results.flatMap((r) => r.release_dates),
		RELEASE_TYPE.PREMIERE,
	);
	if (premiere) return premiere;

	return releaseDate(d.release_date);
}
