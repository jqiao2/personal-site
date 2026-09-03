import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { updateLog, type UpdateLogInput } from '../../../../lib/films';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// PATCH /api/films/logs/123  (owner) — edit rating/review/private note/date/flags/
//                                       medium/tags/friends.
// DELETE /api/films/logs/123 (owner) — soft-delete (sets deleted_at).

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number.parseInt(params.id ?? '', 10);
	if (!Number.isInteger(id) || id <= 0) return apiError('invalid log id', 400);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}

	// Only apply fields that were actually provided.
	const input: UpdateLogInput = {};
	if ('rating' in body) {
		const rating = body.rating == null ? null : Number(body.rating);
		if (rating != null && !(rating >= 0.5 && rating <= 5 && Number.isInteger(rating * 2))) {
			return apiError('rating must be between 0.5 and 5.0 in 0.5 steps', 400);
		}
		input.rating = rating;
	}
	if ('reviewText' in body) input.reviewText = textOrNull(body.reviewText);
	if ('privateNote' in body) input.privateNote = textOrNull(body.privateNote);
	if ('watchedDate' in body) input.watchedDate = dateOrNull(body.watchedDate);
	if ('rewatched' in body) input.rewatched = Boolean(body.rewatched);
	if ('liked' in body) input.liked = Boolean(body.liked);
	// Medium carries its theater venue/format; they only apply to theater viewings.
	if ('medium' in body) {
		input.medium = textOrNull(body.medium);
		input.venue = textOrNull(body.venue);
		input.format = textOrNull(body.format);
	}
	if ('tags' in body) {
		input.tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
	}
	if ('friends' in body) {
		input.friends = Array.isArray(body.friends) ? body.friends.map(String) : [];
	}

	if (Object.keys(input).length === 0) return apiError('no updatable fields provided', 400);

	try {
		const ok = await updateLog(id, input);
		if (!ok) return apiError('log not found', 404);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'update failed', 500);
	}
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number.parseInt(params.id ?? '', 10);
	if (!Number.isInteger(id) || id <= 0) return apiError('invalid log id', 400);

	// Soft delete: stamp deleted_at instead of removing the row. The `is null`
	// guard makes a repeat delete a no-op (404) rather than re-stamping.
	const { data, error } = await supabaseAdmin
		.from('logs')
		.update({ deleted_at: new Date().toISOString() })
		.eq('id', id)
		.is('deleted_at', null)
		.select('id')
		.maybeSingle();
	if (error) return apiError(error.message, 500);
	if (!data) return apiError('log not found', 404);
	return json({ ok: true });
};

function textOrNull(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

function dateOrNull(v: unknown): string | null {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
	return v;
}
