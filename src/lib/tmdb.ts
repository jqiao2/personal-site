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
	genres: { id: number; name: string }[];
	spoken_languages?: { english_name?: string; iso_639_1: string; name: string }[];
	production_countries?: { iso_3166_1: string; name: string }[];
	credits?: {
		cast: { id: number; name: string; character: string; profile_path: string | null }[];
		crew: { id: number; name: string; job: string }[];
	};
	videos?: { results: { key: string; site: string; type: string; name: string }[] };
	similar?: { results: TmdbSearchResult[] };
}

/** Genre + credit name-lists denormalized onto the movie cache row (migration 0008). */
export interface MovieCreditFacts {
	genres: string[];
	languages: string[];
	countries: string[];
	directors: string[];
	actors: string[];
}

/** How many billed cast members to keep per film for the "top actors" aggregate. */
const TOP_CAST = 10;

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

/** Full details + cast + trailers + similar in ONE request (append_to_response). */
export function getMovieDetails(tmdbId: number) {
	return tmdbGet<TmdbMovieDetails>(`/movie/${tmdbId}`, {
		append_to_response: 'credits,videos,similar',
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
