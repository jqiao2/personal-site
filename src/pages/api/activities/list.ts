import type { APIRoute } from 'astro';
import { activityQueryFromParams, fetchActivityPage } from '../../../lib/activity-params';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/activities/list?sort=date&dir=desc&limit=50&offset=0
//   &sport=ride&sport=trail_run&datefrom=2025-01-01&dateto=2025-12-31
//   &distmin=&distmax=&durmin=&durmax=&elevmin=&elevmax=&exmin=&exmax=
//   &gps=1|0&gear=3&indoor=1|0&power=1&hr=1&place=&fav=1&pr=1&measured=1
// → { activities, total } — one page of /activities/all, filtered and sorted
// server-side so paging covers the whole collection rather than what's
// loaded. Multi-value filters (sport, gear) repeat their key. Every param but
// paging is parsed by activityQueryFromParams, which /activities/all also
// renders its first page through — so the two can never read a link
// differently (ACTIVITIES.md §8).
export const GET: APIRoute = async ({ url }) => {
	const p = url.searchParams;
	const limit = clamp(Number.parseInt(p.get('limit') ?? '50', 10), 1, 100, 50);
	const offset = Math.max(0, Number.parseInt(p.get('offset') ?? '0', 10) || 0);

	try {
		const query = activityQueryFromParams(p);
		const { rows, total } = await fetchActivityPage(query, { limit, offset });
		return json({ activities: rows, total });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list activities', 500);
	}
};

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
