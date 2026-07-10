import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// PATCH /api/films/logs/123  (owner) — edit rating/review/date/flags.
// DELETE /api/films/logs/123 (owner) — remove a watch (tags cascade).

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
	const patch: Record<string, unknown> = {};
	if ('rating' in body) {
		const rating = body.rating == null ? null : Number(body.rating);
		if (rating != null && !(rating >= 0.5 && rating <= 5 && Number.isInteger(rating * 2))) {
			return apiError('rating must be between 0.5 and 5.0 in 0.5 steps', 400);
		}
		patch.rating = rating;
	}
	if ('reviewText' in body) patch.review_text = textOrNull(body.reviewText);
	if ('watchedDate' in body) patch.watched_date = dateOrNull(body.watchedDate);
	if ('rewatched' in body) patch.rewatched = Boolean(body.rewatched);
	if ('liked' in body) patch.liked = Boolean(body.liked);

	if (Object.keys(patch).length === 0) return apiError('no updatable fields provided', 400);

	const { data, error } = await supabaseAdmin
		.from('logs')
		.update(patch)
		.eq('id', id)
		.select('id')
		.maybeSingle();
	if (error) return apiError(error.message, 500);
	if (!data) return apiError('log not found', 404);
	return json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number.parseInt(params.id ?? '', 10);
	if (!Number.isInteger(id) || id <= 0) return apiError('invalid log id', 400);

	const { data, error } = await supabaseAdmin
		.from('logs')
		.delete()
		.eq('id', id)
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
