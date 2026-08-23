import type { APIRoute } from 'astro';
import { fetchActivityFacets } from '../../../lib/activity-params';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/activities/facets → sport/gear/place counts plus the min/max of
// every range filter, for the filter panel's chips and sliders.
//
// Unlike the film log's /api/films/watched/facets — which the page defers
// loading until after paint because reading every credit is several times
// the cost of the first page of tiles — this collection is a few hundred
// rows total, so /activities/all reads this same data itself at render time
// (through fetchActivityFacets, not a fetch to this route) and the panel
// never has to show a loading state on first paint. This route exists for
// the client script's re-fetch on retry and for anyone hitting it directly.
// Cached briefly at the edge: the values only move when something is logged.
// OWNER ONLY. The facets describe the private collection — gear nicknames,
// the places rides start from, the longest ride ever — so there is no useful
// visitor version, and the cache header goes private with it: a shared cache
// must not be able to hand one reader's answer to the next one.
export const GET: APIRoute = async ({ cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	try {
		const facets = await fetchActivityFacets(true);
		return json(facets, 200, { 'cache-control': 'private, no-store' });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list activity filters', 500);
	}
};
