import type { APIRoute } from 'astro';
import { getTrending, TmdbError } from '../../../lib/tmdb';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/tmdb/trending  → trending movies this week (homepage widget).
export const GET: APIRoute = async () => {
	try {
		const results = await getTrending();
		return json(results, 200, { 'cache-control': 'public, max-age=3600' });
	} catch (e) {
		if (e instanceof TmdbError) return apiError(e.message, 502);
		return apiError('trending failed', 500);
	}
};
