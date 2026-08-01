import type { APIRoute } from 'astro';
import { listWatchedPage } from '../../../../lib/films';
import { watchedQueryFromParams } from '../../../../lib/watched-params';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/films/watched/list?q=&sort=recent|year&limit=100&offset=0
//   &rmin=&rmax=&unrated=1&liked=1&rewatched=1
//   &dmin=1994&dmax=2003&ryear=2019&tag=…&friend=…&friendmode=any|all
//   &medium=…&venue=…&format=…&wheremode=any|all
//   &director=…&actor=…&genre=…&language=…&country=…
//   &dymin=2019&dymax=2024
// → { films, total } — one page of the "All films" grid, filtered and sorted
// server-side so paging covers the whole collection rather than what's loaded.
// Multi-value filters repeat their key rather than using a delimiter: theater
// names ("AMC 34th Street 14, New York, NY") contain commas of their own.
// Everything but paging is parsed by watchedQueryFromParams, which /films/watched
// also renders its first page through — so the two can't read a link differently.
// (Sibling /api/films/watched?query= stays the favorites-editor autocomplete.)
export const GET: APIRoute = async ({ url }) => {
	const p = url.searchParams;
	const limit = clamp(Number.parseInt(p.get('limit') ?? '100', 10), 1, 100, 100);
	const offset = Math.max(0, Number.parseInt(p.get('offset') ?? '0', 10) || 0);

	try {
		return json(await listWatchedPage({ ...watchedQueryFromParams(p), limit, offset }));
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list watched films', 500);
	}
};

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
