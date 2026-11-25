// Reading Letterboxd's public pages. Letterboxd has no API for a watchlist and no
// RSS feed of one, so these parse the HTML the site serves to a browser. Pure
// functions, no database, so scripts/letterboxd-watchlist.test.mjs can run them.

export const LETTERBOXD_USER = 'jasonqiao';

const ORIGIN = 'https://letterboxd.com';

// Letterboxd answers a bare fetch, but a browser-ish User-Agent is what the RSS
// catch-up script has always sent (wiki 0027).
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; jqiao-site watchlist sync)' };

/** Film slugs on one page of a watchlist grid, in page order (newest added first).
 *  Each poster is a `LazyPoster` component carrying `data-item-slug`; older markup
 *  called it `data-film-slug`, so either is accepted. */
export function parseWatchlistPage(html: string): string[] {
	const slugs: string[] = [];

	for (const m of html.matchAll(/data-(?:item|film)-slug="([^"]+)"/g)) {
		if (!slugs.includes(m[1])) slugs.push(m[1]);
	}

	return slugs;
}

/** The TMDB movie id on a Letterboxd film page, from `<body data-tmdb-type="movie"
 *  data-tmdb-id="238">`. Null for a page with no movie id: TV miniseries listed as
 *  films (Twin Peaks: The Return) carry an empty id. */
export function parseFilmTmdbId(html: string): number | null {
	const body = html.match(/<body\b[^>]*>/)?.[0];

	if (!body) throw new Error('film page has no <body>');

	if (body.match(/data-tmdb-type="([^"]*)"/)?.[1] !== 'movie') return null;

	const id = Number(body.match(/data-tmdb-id="(\d+)"/)?.[1]);

	return Number.isInteger(id) && id > 0 ? id : null;
}

async function get(path: string): Promise<string> {
	const res = await fetch(`${ORIGIN}${path}`, { headers: HEADERS });

	if (!res.ok) throw new Error(`letterboxd ${path} answered ${res.status}`);

	return res.text();
}

/** Every film slug on a user's public watchlist, newest added first. Walks
 *  `/watchlist/page/N/` until a page comes back empty. A page that fails throws,
 *  so a partial list never reaches the caller and never reads as removals. */
export async function fetchWatchlistSlugs(user: string): Promise<string[]> {
	const slugs: string[] = [];

	// 28 films a page; 200 pages is 5,600 films, far past any real watchlist.
	for (let page = 1; page <= 200; page++) {
		const found = parseWatchlistPage(await get(`/${user}/watchlist/page/${page}/`));

		if (!found.length) return slugs;

		slugs.push(...found);
	}

	throw new Error('letterboxd watchlist ran past 200 pages');
}

/** The TMDB movie id of one Letterboxd film, read from its page. */
export async function fetchFilmTmdbId(slug: string): Promise<number | null> {
	return parseFilmTmdbId(await get(`/film/${encodeURIComponent(slug)}/`));
}

/** One film already on the site's watchlist. */
export interface WatchlistEntry {
	movieId: number;
	tmdbId: number;
	fromLetterboxd: boolean;
}

export interface WatchlistPlan {
	/** TMDB ids to add, newest on Letterboxd first. */
	add: number[];
	/** Site rows that are also on Letterboxd: Letterboxd decides them from now on. */
	claim: number[];
	/** Site rows that came from Letterboxd and have left it. */
	remove: number[];
}

/** What it takes to make the site's watchlist follow Letterboxd's.
 *
 *  Letterboxd owns any film it lists, so a film it drops leaves the site too. A
 *  film added on the site and never on Letterboxd is the site's own and is left
 *  alone. A film already in `watched` is not added back: logging a film takes it
 *  off the watchlist, and Letterboxd often still lists it a while after. */
export function planWatchlistSync(letterboxd: number[], rows: WatchlistEntry[], watched: Set<number>): WatchlistPlan {
	const onLetterboxd = new Set(letterboxd);

	const onSite = new Set(rows.map((r) => r.tmdbId));

	const add = [...onLetterboxd].filter((id) => !onSite.has(id) && !watched.has(id));

	const claim: number[] = [];

	const remove: number[] = [];

	for (const row of rows) {
		if (onLetterboxd.has(row.tmdbId)) {
			if (!row.fromLetterboxd) claim.push(row.movieId);
		} else if (row.fromLetterboxd) {
			remove.push(row.movieId);
		}
	}

	return { add, claim, remove };
}
