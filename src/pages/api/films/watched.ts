import type { APIRoute } from 'astro';
import { searchWatchedMovies } from '../../../lib/films';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/films/watched?query=foo → search your watched films by title.
// Public; used by the favorites editor (favorites can only come from watched films).
export const GET: APIRoute = async ({ url }) => {
	const query = url.searchParams.get('query') ?? '';
	try {
		return json({ results: await searchWatchedMovies(query) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'search failed', 500);
	}
};
