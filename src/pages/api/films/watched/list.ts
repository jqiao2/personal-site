import type { APIRoute } from 'astro';
import { isWatchedSort, listWatchedPage } from '../../../../lib/films';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/films/watched/list?q=&sort=recent|year&limit=100&offset=0
// → { films, total } — one page of the "All films" grid, filtered and sorted
// server-side so paging covers the whole collection rather than what's loaded.
// (Sibling /api/films/watched?query= stays the favorites-editor autocomplete.)
export const GET: APIRoute = async ({ url }) => {
	const limit = clamp(Number.parseInt(url.searchParams.get('limit') ?? '100', 10), 1, 100, 100);
	const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
	const sortParam = url.searchParams.get('sort');
	const sort = isWatchedSort(sortParam) ? sortParam : 'recent';

	try {
		const page = await listWatchedPage({
			q: url.searchParams.get('q') ?? '',
			sort,
			limit,
			offset,
		});
		return json(page);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list watched films', 500);
	}
};

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
