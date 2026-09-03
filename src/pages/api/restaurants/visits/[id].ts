import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';
import { deleteVisit, getVisit, updateVisit } from '../../../../lib/restaurants';

export const prerender = false;

// GET /api/restaurants/visits/:id → one visit with its photographs.
export const GET: APIRoute = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);
	try {
		const visit = await getVisit(id);
		return visit ? json({ visit }) : apiError('not found', 404);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to read the visit', 500);
	}
};

// PATCH /api/restaurants/visits/:id  (owner only) — amend a visit. Only the
// fields present in the body are touched, so the composer can send just the
// heart toggle without resending the review.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const patch: Parameters<typeof updateVisit>[1] = {};
	if ('visitedOn' in body) {
		const date = typeof body.visitedOn === 'string' ? body.visitedOn : '';
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError('visitedOn must be YYYY-MM-DD', 400);
		patch.visitedOn = date;
	}
	if ('rating' in body) {
		const r = body.rating == null ? null : Number(body.rating);
		if (r != null && !(Number.isFinite(r) && r >= 0.5 && r <= 5 && Number.isInteger(r * 2))) {
			return apiError('rating must be between 0.5 and 5.0 in half steps', 400);
		}
		patch.rating = r;
	}
	if ('verdict' in body) {
		const v = body.verdict == null ? null : Number(body.verdict);
		if (v != null && !(Number.isInteger(v) && v >= 0 && v <= 5)) {
			return apiError('verdict must be a rank between 0 and 5', 400);
		}
		patch.verdict = v;
	}
	if ('hearted' in body) patch.hearted = Boolean(body.hearted);
	if ('revisit' in body) patch.revisit = Boolean(body.revisit);
	if ('friends' in body) patch.friends = Array.isArray(body.friends) ? body.friends.map(String) : [];
	if ('tags' in body) patch.tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
	if ('review' in body) patch.review = typeof body.review === 'string' ? body.review : null;
	if ('privateNote' in body) patch.privateNote = typeof body.privateNote === 'string' ? body.privateNote : null;

	try {
		await updateVisit(id, patch);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to update the visit', 500);
	}
};

// DELETE /api/restaurants/visits/:id  (owner only) — soft delete.
export const DELETE: APIRoute = async ({ params, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);
	try {
		await deleteVisit(id);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to delete the visit', 500);
	}
};
