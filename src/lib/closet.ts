// The closet at /films/closet: the watchlist and everything watched, drawn as
// two walls of disc cases. Reads the whole of both collections plus the diary,
// and turns each film into a spine — colour, case, number and the three sort
// ranks the page's toggle switches between — so the .astro file stays markup.
import { supabasePublic } from './supabase';
import { seed01 } from './books-view';
import { excerpt, formatWatchedDate, starText } from './format';
import { imageUrl } from './tmdb';

/** PostgREST answers at most 1000 rows a request, and the watched wall is past it. */
const PAGE = 1000;

async function readAll<T>(name: string, page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
	const rows: T[] = [];

	for (let from = 0; ; from += PAGE) {
		const { data, error } = await page(from, from + PAGE - 1);

		if (error) throw new Error(`${name} failed: ${error.message}`);

		// SAFETY: each caller's select string names exactly T's columns.
		const batch = (data ?? []) as T[];

		rows.push(...batch);

		if (batch.length < PAGE) return rows;
	}
}

interface Movie {
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
}

/** One diary log as the opened case lists it. */
export interface ClosetLog {
	id: number;
	date: string | null;
	stars: string | null;
	liked: boolean;
	rewatched: boolean;
	note: string | null;
}

export interface ClosetSpine {
	tmdb: number;
	title: string;
	year: number | null;
	/** The case's spine number: order it came into this collection, 1 = first. */
	number: number;
	stars: string | null;
	poster: string | null;
	/** A small poster for the sliver of cover seen on a case's side. */
	thumb: string | null;
	case: string;
	ink: string;
	/** Positions under each sort, 0-based; the page reorders by these. */
	rank: { recent: number; alpha: number; year: number };
	/** "Watched Mar 3, 2025" / "Added Mar 3, 2025" — the opened case's subline. */
	when: string | null;
}

export interface Closet {
	watchlist: ClosetSpine[];
	watched: ClosetSpine[];
	/** Diary logs by TMDB id, newest first; only watched films have any. */
	logs: Record<number, ClosetLog[]>;
}

/**
 * Case colours: the flat, printed spines of a boutique label rather than book
 * cloth. Paired with the ink that reads on them.
 */
const CASES: [string, string][] = [
	['#e9e2d0', '#1b1a17'],
	['#1b1a17', '#e9e2d0'],
	['#b3261e', '#f4ead6'],
	['#20324f', '#e9e2d0'],
	['#c9a227', '#1b1a17'],
	['#2f5d50', '#f0e6cf'],
	['#d9d4c7', '#7a1e18'],
	['#5b2a3c', '#efe3cc'],
	['#3d3a36', '#d9b45a'],
	['#8a4b2a', '#f4ead6'],
	['#f2efe8', '#20324f'],
	['#6f7f86', '#f7f2e6'],
];

/** Leading articles a shop ignores when it files a title. */
const ARTICLE = /^(the|a|an)\s+/i;

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Position of each item when sorted by `cmp`, keyed back to its input index. */
function ranks<T>(items: T[], cmp: (a: T, b: T) => number): number[] {
	const out: number[] = [];

	items
		.map((item, i) => ({ item, i }))
		.sort((a, b) => cmp(a.item, b.item) || a.i - b.i)
		.forEach(({ i }, r) => {
			out[i] = r;
		});

	return out;
}

interface Raw {
	movie: Movie;
	/** Insertion id in its table — what the spine number counts by. */
	id: number;
	/** "YYYY-MM-DD…" the recent sort orders by, newest first; '' sorts last. */
	recent: string;
	rating: number | null;
	when: string | null;
}

function toSpines(raws: Raw[]): ClosetSpine[] {
	const numbers = ranks(raws, (a, b) => a.id - b.id);
	const recent = ranks(raws, (a, b) => b.recent.localeCompare(a.recent) || b.id - a.id);
	const alpha = ranks(raws, (a, b) => collator.compare(a.movie.title.replace(ARTICLE, ''), b.movie.title.replace(ARTICLE, '')));
	const year = ranks(raws, (a, b) => (a.movie.release_year ?? 9999) - (b.movie.release_year ?? 9999) || collator.compare(a.movie.title, b.movie.title));

	// Shipped in the default (recent) order; the page re-sorts by `rank`.
	const spines = raws.map((r, i): ClosetSpine => {
		const tmdb = r.movie.tmdb_id;
		const [bg, ink] = CASES[Math.floor(seed01(String(tmdb), 'case') * CASES.length)];

		return {
			tmdb,
			title: r.movie.title,
			year: r.movie.release_year,
			number: numbers[i] + 1,
			stars: starText(r.rating),
			poster: imageUrl(r.movie.poster_path, 'w500'),
			thumb: imageUrl(r.movie.poster_path, 'w185'),
			case: bg,
			ink,
			rank: { recent: recent[i], alpha: alpha[i], year: year[i] },
			when: r.when,
		};
	});

	return spines.sort((a, b) => a.rank.recent - b.rank.recent);
}

export async function loadCloset(): Promise<Closet> {
	type WatchedRow = { id: number; first_watched: string | null; rating: number | null; movies: Movie };

	type ListRow = { id: number; added_at: string; movies: Movie };

	type LogRow = {
		id: number;
		tmdb_id: number;
		watched_date: string | null;
		rating: number | null;
		review_text: string | null;
		liked: boolean;
		rewatched: boolean;
	};

	const MOVIE = 'movies!inner(tmdb_id, title, release_year, poster_path)';

	const [watchedRows, listRows, logRows] = await Promise.all([
		readAll<WatchedRow>('closet watched', (from, to) =>
			supabasePublic.from('watched').select(`id, first_watched, rating, ${MOVIE}`).order('id').range(from, to),
		),
		readAll<ListRow>('closet watchlist', (from, to) =>
			supabasePublic.from('watchlist').select(`id, added_at, ${MOVIE}`).order('id').range(from, to),
		),
		readAll<LogRow>('closet logs', (from, to) =>
			supabasePublic
				.from('logs_with_movie')
				.select('id, tmdb_id, watched_date, rating, review_text, liked, rewatched')
				.order('watched_date', { ascending: false, nullsFirst: false })
				.order('id', { ascending: false })
				.range(from, to),
		),
	]);

	const logs: Record<number, ClosetLog[]> = {};
	const lastWatched = new Map<number, string>();

	for (const l of logRows) {
		(logs[l.tmdb_id] ??= []).push({
			id: l.id,
			date: formatWatchedDate(l.watched_date),
			stars: starText(l.rating),
			liked: l.liked,
			rewatched: l.rewatched,
			note: excerpt(l.review_text),
		});

		// Rows arrive newest first, so the first date seen per film is its latest.
		if (l.watched_date && !lastWatched.has(l.tmdb_id)) lastWatched.set(l.tmdb_id, l.watched_date);
	}

	const watched = toSpines(
		watchedRows.map((w) => {
			// Letterboxd imports have no first_watched, but usually a dated log.
			const recent = lastWatched.get(w.movies.tmdb_id) ?? w.first_watched?.slice(0, 10) ?? '';

			return {
				movie: w.movies,
				id: w.id,
				recent,
				rating: w.rating,
				when: recent ? `Last watched ${formatWatchedDate(recent.slice(0, 10))}` : 'Watched',
			};
		}),
	);

	const watchlist = toSpines(
		listRows.map((w) => ({
			movie: w.movies,
			id: w.id,
			recent: w.added_at,
			rating: null,
			when: `On the watchlist since ${formatWatchedDate(w.added_at.slice(0, 10))}`,
		})),
	);

	return { watchlist, watched, logs };
}
