import type { APIRoute } from 'astro';
import { supabasePublic, supabaseAdmin } from '../../../lib/supabase';
import { ensureMovieCached } from '../../../lib/films';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET    /api/films/watchlist              → public list, newest first.
// POST   /api/films/watchlist { tmdbId }   → (owner) add a movie.
// DELETE /api/films/watchlist?tmdbId=123   → (owner) remove a movie.

export const GET: APIRoute = async () => {
	const { data, error } = await supabasePublic
		.from('watchlist')
		.select('id, added_at, movies(tmdb_id, title, release_year, poster_path)')
		.order('added_at', { ascending: false });
	if (error) return apiError(error.message, 500);
	return json({ watchlist: data });
};

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: { tmdbId?: unknown };
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}
	const tmdbId = Number(body.tmdbId);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);

	try {
		const movie = await ensureMovieCached(tmdbId);
		// Idempotent: movie_id is unique, so re-adding is a no-op.
		const { error } = await supabaseAdmin
			.from('watchlist')
			.upsert({ movie_id: movie.id }, { onConflict: 'movie_id' });
		if (error) return apiError(error.message, 500);
		return json({ ok: true }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to add', 500);
	}
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const tmdbId = Number.parseInt(url.searchParams.get('tmdbId') ?? '', 10);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);

	// Resolve the local movie id, then delete the watchlist row.
	const { data: movie, error: lookupErr } = await supabaseAdmin
		.from('movies')
		.select('id')
		.eq('tmdb_id', tmdbId)
		.maybeSingle();
	if (lookupErr) return apiError(lookupErr.message, 500);
	if (!movie) return apiError('not on watchlist', 404);

	const { data, error } = await supabaseAdmin
		.from('watchlist')
		.delete()
		.eq('movie_id', movie.id)
		.select('id')
		.maybeSingle();
	if (error) return apiError(error.message, 500);
	if (!data) return apiError('not on watchlist', 404);
	return json({ ok: true });
};
