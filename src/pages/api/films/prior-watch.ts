import type { APIRoute } from 'astro';
import { getPriorWatch } from '../../../lib/films';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/films/prior-watch?tmdbId=123
// Whether this film has been watched before, plus the most recent rating/like to
// pre-fill in the diary composer (so re-logging a film suggests a rewatch). The
// data is already public on film pages, so this read is unauthenticated.
export const GET: APIRoute = async ({ url }) => {
	const tmdbId = Number(url.searchParams.get('tmdbId'));
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);

	try {
		const prior = await getPriorWatch(tmdbId);
		return json(prior, 200, { 'cache-control': 'no-store' });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'prior-watch lookup failed', 500);
	}
};
