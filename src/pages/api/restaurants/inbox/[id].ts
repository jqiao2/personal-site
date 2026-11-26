import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';
import { dismissPending, logPending, readPending } from '../../../../lib/food-inbox';

export const prerender = false;

function idOf(raw: string | undefined): number | null {
	const id = Number(raw);

	return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/restaurants/inbox/:id  (owner only) — the photograph. It lives in a
// private bucket, so this route is the only way to see it.
export const GET: APIRoute = async ({ params, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = idOf(params.id);

	if (id == null) return apiError('bad id', 400);

	try {
		const blob = await readPending(id);

		if (!blob) return apiError('not in the inbox', 404);

		return new Response(blob, {
			headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=604800, immutable' },
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to read the photograph', 500);
	}
};

// POST /api/restaurants/inbox/:id  (owner only) { visitId } — put it on a visit.
export const POST: APIRoute = async ({ params, request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = idOf(params.id);
	const body = await request.json().catch(() => null);
	const visitId = idOf(String(body?.visitId));

	if (id == null || visitId == null) return apiError('expected an id and {visitId}', 400);

	try {
		const ids = await logPending(id, visitId);

		return ids ? json({ ids }, 201) : apiError('not in the inbox', 404);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to move the photograph', 500);
	}
};

// DELETE /api/restaurants/inbox/:id  (owner only) — a false positive.
export const DELETE: APIRoute = async ({ params, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = idOf(params.id);

	if (id == null) return apiError('bad id', 400);

	try {
		return (await dismissPending(id)) ? json({ ok: true }) : apiError('not in the inbox', 404);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to dismiss the photograph', 500);
	}
};
