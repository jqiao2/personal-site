import type { APIRoute } from 'astro';
import { fetchActivityFacets } from '../../../lib/activity-params';
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
export const GET: APIRoute = async () => {
	try {
		const facets = await fetchActivityFacets();
		return json(facets, 200, {
			'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list activity filters', 500);
	}
};
