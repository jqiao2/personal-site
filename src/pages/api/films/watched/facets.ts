import type { APIRoute } from 'astro';
import { listWatchedFacets } from '../../../../lib/films';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/films/watched/facets → every value the "All films" filter chips offer.
//
// This is the expensive half of that page: reading the whole collection's credits,
// tags, theaters and watch years costs several times what rendering the first 100
// tiles does. The panel it feeds starts collapsed, so /films/watched no longer waits
// on it — the grid ships first and the chips arrive here, after paint.
//
// Cached briefly at the edge: the values only move when something is logged, and a
// few seconds of staleness in a filter chip is invisible, while a shared link or a
// second tab gets the panel instantly.
export const GET: APIRoute = async ({ cookies }) => {
	try {
		const isOwner = await requireOwner(cookies);
		const facets = await listWatchedFacets(isOwner);
		// The owner response carries friend chips; it must never land in the shared
		// edge cache where a visitor could be served it. Only the redacted visitor
		// response is cacheable.
		return json(facets, 200, {
			'cache-control': isOwner
				? 'private, no-store'
				: 'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list filter facets', 500);
	}
};
