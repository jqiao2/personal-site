import type { APIRoute } from 'astro';
import { isMatchMode, isWatchedSort, listWatchedPage } from '../../../../lib/films';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/films/watched/list?q=&sort=recent|year&limit=100&offset=0
//   &rmin=&rmax=&unrated=1&liked=1&rewatched=1
//   &decade=1990&decade=2000&tag=…&friend=…&friendmode=any|all
//   &medium=…&venue=…&format=…&wheremode=any|all
//   &director=…&actor=…
// → { films, total } — one page of the "All films" grid, filtered and sorted
// server-side so paging covers the whole collection rather than what's loaded.
// Multi-value filters repeat their key rather than using a delimiter: theater
// names ("AMC 34th Street 14, New York, NY") contain commas of their own.
// (Sibling /api/films/watched?query= stays the favorites-editor autocomplete.)
export const GET: APIRoute = async ({ url }) => {
	const p = url.searchParams;
	const limit = clamp(Number.parseInt(p.get('limit') ?? '100', 10), 1, 100, 100);
	const offset = Math.max(0, Number.parseInt(p.get('offset') ?? '0', 10) || 0);
	const sortParam = p.get('sort');
	const sort = isWatchedSort(sortParam) ? sortParam : 'recent';

	// Only pass a bound through when it actually narrows: the client omits the
	// param at the slider's extremes, and a half-star grid keeps 0.5 ≤ v ≤ 5.
	const rmin = starBound(p.get('rmin'));
	const rmax = starBound(p.get('rmax'));

	try {
		const page = await listWatchedPage({
			q: p.get('q') ?? '',
			sort,
			limit,
			offset,
			ratingMin: rmin,
			ratingMax: rmax,
			unratedOnly: p.get('unrated') === '1',
			liked: p.get('liked') === '1',
			rewatched: p.get('rewatched') === '1',
			decades: p.getAll('decade').map(Number).filter(Number.isFinite),
			directors: p.getAll('director'),
			actors: p.getAll('actor'),
			tags: p.getAll('tag'),
			friends: p.getAll('friend'),
			friendMode: isMatchMode(p.get('friendmode')) ? p.get('friendmode')! : 'any',
			mediums: p.getAll('medium'),
			venues: p.getAll('venue'),
			formats: p.getAll('format'),
			whereMode: isMatchMode(p.get('wheremode')) ? p.get('wheremode')! : 'any',
		});
		return json(page);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list watched films', 500);
	}
};

/** A rating bound snapped to the half-star grid, or undefined if absent/invalid. */
function starBound(raw: string | null): number | undefined {
	if (raw == null) return undefined;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return undefined;
	return Math.min(5, Math.max(0.5, Math.round(n * 2) / 2));
}

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
