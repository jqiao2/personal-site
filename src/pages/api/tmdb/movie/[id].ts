import type { APIRoute } from 'astro';
import { getMovieDetails, TmdbError } from '../../../../lib/tmdb';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// GET /api/tmdb/movie/1234
// Full details + cast + trailers + similar in one upstream call.
export const GET: APIRoute = async ({ params }) => {
	const id = Number.parseInt(params.id ?? '', 10);
	if (!Number.isFinite(id) || id <= 0) return apiError('invalid movie id', 400);

	try {
		const details = await getMovieDetails(id);
		return json(details, 200, { 'cache-control': 'public, max-age=3600' });
	} catch (e) {
		if (e instanceof TmdbError) return apiError(e.message, e.status === 404 ? 404 : 502);
		return apiError('lookup failed', 500);
	}
};
