import type { APIRoute } from 'astro';
import { searchMovies, TmdbError } from '../../../lib/tmdb';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/tmdb/search?query=blade+runner&page=1
// Live search proxy. Debounce keystrokes (~300ms) on the client before calling.
export const GET: APIRoute = async ({ url }) => {
	const query = url.searchParams.get('query')?.trim();
	if (!query) return apiError('missing ?query', 400);
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;

	try {
		const results = await searchMovies(query, page);
		return json(results, 200, { 'cache-control': 'public, max-age=60' });
	} catch (e) {
		if (e instanceof TmdbError) return apiError(e.message, 502);
		return apiError('search failed', 500);
	}
};
