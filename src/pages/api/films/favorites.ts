import type { APIRoute } from 'astro';
import { listFavorites, setFavorite, FavoritesFullError } from '../../../lib/films';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET    /api/films/favorites            → public list of favorite films.
// POST   /api/films/favorites { tmdbId } → (owner) mark a watched film favorite.
// DELETE /api/films/favorites?tmdbId=123 → (owner) unmark.

export const GET: APIRoute = async () => {
	try {
		return json({ favorites: await listFavorites() });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list favorites', 500);
	}
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
		await setFavorite(tmdbId, true);
		return json({ ok: true }, 201);
	} catch (e) {
		if (e instanceof FavoritesFullError) return apiError(e.message, 409);
		return apiError(e instanceof Error ? e.message : 'failed to add favorite', 500);
	}
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const tmdbId = Number.parseInt(url.searchParams.get('tmdbId') ?? '', 10);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);

	try {
		await setFavorite(tmdbId, false);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to remove favorite', 500);
	}
};
