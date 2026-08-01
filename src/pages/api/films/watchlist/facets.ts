import type { APIRoute } from 'astro';
import { listWatchlistFacets } from '../../../../lib/films';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/films/watchlist/facets → [{ tmdb_id, genres, directors, actors, language }]
//
// The values behind the watchlist's Genre / Language / People filters, one row per
// film. Keyed by TMDB id so the page can attach each row to the tile already on
// screen. Kept out of the page's own query because these arrays are most of its
// weight — as a response and, once written out as per-tile data attributes, as
// HTML — for a panel that starts collapsed.
//
// Cached briefly at the edge: the values only move when the watchlist changes, and
// a few seconds of staleness in a filter chip is invisible.
export const GET: APIRoute = async () => {
	try {
		const rows = await listWatchlistFacets();
		return json(rows, 200, {
			'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list watchlist facets', 500);
	}
};
