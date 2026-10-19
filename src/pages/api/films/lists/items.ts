import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
import { supabaseAdmin } from '../../../../lib/supabase';
import { ensureMovieCached } from '../../../../lib/films';
import { isManualList, movieIdsByTmdb, nextPosition } from '../../../../lib/film-lists';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// POST   /api/films/lists/items { listId, tmdbId }         → (owner) add a film at the end.
// PUT    /api/films/lists/items { listId, tmdbIds: [...] } → (owner) set the list's order.
// DELETE /api/films/lists/items?listId=1&tmdbId=123        → (owner) remove a film.
//
// Only hand-picked lists hold items; a smart list is filled by its filters.

const id = z.coerce.number().int().positive();

const one = z.object({ listId: id, tmdbId: id });

const order = z.object({ listId: id, tmdbIds: z.array(id).min(1).max(2000) });

const notManual = () => apiError('no such hand-picked list', 404);

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = one.safeParse(await request.json().catch(() => null));

	if (!b.success) return apiError('expected { listId, tmdbId }', 400);
	const { listId, tmdbId } = b.data;

	try {
		if (!(await isManualList(listId))) return notManual();
		const movie = await ensureMovieCached(tmdbId);

		// Re-adding a film already on the list leaves it where it was.
		const { error } = await supabaseAdmin
			.from('film_list_items')
			.upsert(
				{ list_id: listId, movie_id: movie.id, position: await nextPosition('film_list_items', listId) },
				{ onConflict: 'list_id,movie_id', ignoreDuplicates: true },
			);

		if (error) return apiError(error.message, 500);

		return json({ ok: true }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to add', 500);
	}
};

export const PUT: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = order.safeParse(await request.json().catch(() => null));

	if (!b.success) return apiError('expected { listId, tmdbIds }', 400);
	const { listId, tmdbIds } = b.data;

	try {
		if (!(await isManualList(listId))) return notManual();
		const movieIds = await movieIdsByTmdb(tmdbIds);

		// ponytail: one update per film; fine for lists of a few hundred.
		const results = await Promise.all(
			tmdbIds.map((t, position) =>
				supabaseAdmin
					.from('film_list_items')
					.update({ position })
					.eq('list_id', listId)
					.eq('movie_id', movieIds.get(t) ?? -1),
			),
		);

		const failed = results.find((r) => r.error);

		if (failed?.error) return apiError(failed.error.message, 500);

		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to reorder', 500);
	}
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = one.safeParse(Object.fromEntries(url.searchParams));

	if (!b.success) return apiError('listId and tmdbId are required', 400);
	const { listId, tmdbId } = b.data;

	try {
		const movieId = (await movieIdsByTmdb([tmdbId])).get(tmdbId);

		if (movieId == null) return apiError('not on list', 404);

		const { error } = await supabaseAdmin
			.from('film_list_items')
			.delete()
			.eq('list_id', listId)
			.eq('movie_id', movieId);

		if (error) return apiError(error.message, 500);

		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to remove', 500);
	}
};
