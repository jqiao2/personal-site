import { isMatchMode, isWatchedSort, type WatchedQuery } from './films';

/**
 * The "All films" filter state, read out of a query string.
 *
 * /films/watched and /api/films/watched/list parse the same params through here,
 * so the server-rendered first page and the batches the grid pages in afterwards
 * can't drift apart. They differ in one spelling: the API takes the release-date
 * filter as the list of decades it should match (`decade=1990&decade=2000`),
 * while the page URL carries the span the slider was left at
 * (`dmin=1990&dmax=2000`) because that's the form a person reads. Both are
 * accepted; an explicit list wins when somehow both are present.
 *
 * Anything unrecognized falls back to "don't filter by this" rather than
 * erroring — these params are hand-editable and arrive from old links.
 */
export function watchedQueryFromParams(p: URLSearchParams): WatchedQuery {
	const sort = p.get('sort');
	const friendMode = p.get('friendmode');
	const whereMode = p.get('wheremode');
	return {
		q: p.get('q')?.trim() ?? '',
		sort: isWatchedSort(sort) ? sort : 'recent',
		ratingMin: starBound(p.get('rmin')),
		ratingMax: starBound(p.get('rmax')),
		unratedOnly: p.get('unrated') === '1',
		liked: p.get('liked') === '1',
		rewatched: p.get('rewatched') === '1',
		decades: decades(p),
		releaseYears: p.getAll('ryear').map(Number).filter(Number.isFinite),
		directors: p.getAll('director'),
		actors: p.getAll('actor'),
		genres: p.getAll('genre'),
		languages: p.getAll('language'),
		countries: p.getAll('country'),
		diaryYearMin: yearBound(p.get('dymin')),
		diaryYearMax: yearBound(p.get('dymax')),
		tags: p.getAll('tag'),
		friends: p.getAll('friend'),
		friendMode: isMatchMode(friendMode) ? friendMode : 'any',
		mediums: p.getAll('medium'),
		venues: p.getAll('venue'),
		formats: p.getAll('format'),
		whereMode: isMatchMode(whereMode) ? whereMode : 'any',
	};
}

/**
 * How many filters are on — the number the grid's "Filters" button badges. Each
 * range counts once however many steps it spans, mirroring the panel's own count.
 * The search term isn't counted: it has its own box, outside the panel.
 */
export function watchedFilterCount(q: WatchedQuery): number {
	let n =
		(q.unratedOnly || q.ratingMin != null || q.ratingMax != null ? 1 : 0) +
		(q.decades?.length ? 1 : 0) +
		(q.diaryYearMin != null || q.diaryYearMax != null ? 1 : 0) +
		(q.liked ? 1 : 0) +
		(q.rewatched ? 1 : 0) +
		(q.releaseYears?.length ?? 0);
	const lists = [
		q.tags,
		q.friends,
		q.mediums,
		q.venues,
		q.formats,
		q.directors,
		q.actors,
		q.genres,
		q.languages,
		q.countries,
	];
	for (const list of lists) n += list?.length ?? 0;
	return n;
}

/**
 * Whether the query narrows the collection at all — i.e. whether its `total`
 * counts a slice rather than everything watched. Sort isn't a filter; search is.
 */
export function isWatchedFiltered(q: WatchedQuery): boolean {
	return Boolean(q.q) || watchedFilterCount(q) > 0;
}

/** Earliest decade worth asking for — film predates it by nothing worth charting. */
const DECADE_FLOOR = 1870;

/**
 * The release decades to match, as their first years.
 *
 * Either the explicit list the API takes, or the page URL's `dmin`/`dmax` span
 * expanded into one. The span is clamped to the film era at one end and the
 * current decade at the other, so a hand-typed `?dmin=0` asks for a dozen
 * decades rather than two hundred. A missing bound leaves that end open, which
 * mirrors the slider — it only ever writes a bound that narrows.
 */
function decades(p: URLSearchParams): number[] {
	const explicit = p.getAll('decade').map(Number).filter(Number.isFinite);
	if (explicit.length) return explicit;

	const rawMin = p.get('dmin');
	const rawMax = p.get('dmax');
	if (rawMin == null && rawMax == null) return [];

	const ceiling = Math.floor((new Date().getFullYear() + 5) / 10) * 10;
	const snap = (raw: string | null, fallback: number) => {
		const n = Number(raw);
		if (raw == null || !Number.isFinite(n)) return fallback;
		return Math.min(ceiling, Math.max(DECADE_FLOOR, Math.round(n / 10) * 10));
	};
	const lo = snap(rawMin, DECADE_FLOOR);
	const hi = snap(rawMax, ceiling);
	if (hi < lo) return [];

	const out: number[] = [];
	for (let d = lo; d <= hi; d += 10) out.push(d);
	return out;
}

/** A diary-date year bound as an integer, or undefined if absent/invalid. */
function yearBound(raw: string | null): number | undefined {
	if (raw == null) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * A rating bound snapped to the half-star grid, or undefined if absent/invalid.
 * Only a bound that narrows is ever sent — the client omits the param at the
 * slider's extremes — so this doesn't second-guess a bound that reaches an end.
 */
function starBound(raw: string | null): number | undefined {
	if (raw == null) return undefined;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return undefined;
	return Math.min(5, Math.max(0.5, Math.round(n * 2) / 2));
}
