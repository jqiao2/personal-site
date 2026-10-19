import type { APIRoute } from 'astro';
import { saveRanking } from '../../../lib/film-rank';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// PUT /api/films/ranking { order: number[] } → (owner) replace the whole ranking,
// best first, as movies.id. /films/rank sends it after every placement and undo.
export const PUT: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: { order?: unknown };

	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}

	const { order } = body;

	if (
		!Array.isArray(order) ||
		!order.every((id) => Number.isInteger(id) && id > 0) ||
		new Set(order).size !== order.length
	) {
		return apiError('order must be distinct positive integers', 400);
	}

	try {
		await saveRanking(order);

		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'save failed', 500);
	}
};
