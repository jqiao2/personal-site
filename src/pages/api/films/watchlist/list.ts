import type { APIRoute } from 'astro';
import { listWatchlistPage, watchlistQueryFromParams } from '../../../../lib/watchlist-page';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/films/watchlist/list?q=&sort=added|year|shuffle&seed=&limit=100&offset=0
//   &dmin=1994&dmax=2003&upcoming=0
//   &genre=…&genremode=any|all&language=…&director=…&actor=…
// → { films, total } — one page of the Watchlist grid, filtered and sorted
// server-side so paging covers the whole list rather than what's loaded. Everything
// but paging is parsed by watchlistQueryFromParams, which /films/watchlist also
// renders its first page through — so the two can't read a link differently.
export const GET: APIRoute = async ({ url }) => {
	const p = url.searchParams;
	const limit = clamp(Number.parseInt(p.get('limit') ?? '100', 10), 1, 100, 100);
	const offset = Math.max(0, Number.parseInt(p.get('offset') ?? '0', 10) || 0);

	try {
		return json(await listWatchlistPage({ ...watchlistQueryFromParams(p), limit, offset }));
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list watchlist', 500);
	}
};

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;

	return Math.min(max, Math.max(min, n));
}
