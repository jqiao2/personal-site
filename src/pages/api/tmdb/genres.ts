import type { APIRoute } from 'astro';
import { getGenres, TmdbError } from '../../../lib/tmdb';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/tmdb/genres  → id→name list for filter dropdowns. Rarely changes.
export const GET: APIRoute = async () => {
	try {
		const genres = await getGenres();
		return json(genres, 200, { 'cache-control': 'public, max-age=86400' });
	} catch (e) {
		if (e instanceof TmdbError) return apiError(e.message, 502);
		return apiError('genres failed', 500);
	}
};
