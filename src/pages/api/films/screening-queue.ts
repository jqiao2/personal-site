import type { APIRoute } from 'astro';
import { listQueue, addToQueue, removeFromQueue } from '../../../lib/screening-queue';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET    /api/films/screening-queue                        → public list, earliest first.
// POST   /api/films/screening-queue { tmdbId, date, venue? } → (owner) schedule a film.
// DELETE /api/films/screening-queue?tmdbId=123             → (owner) unschedule.

export const GET: APIRoute = async () => {
	try {
		return json({ queue: await listQueue() });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list', 500);
	}
};

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: { tmdbId?: unknown; date?: unknown; venue?: unknown };
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}
	const tmdbId = Number(body.tmdbId);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);
	const date = String(body.date ?? '');
	if (!DATE_RE.test(date)) return apiError('date (YYYY-MM-DD) is required', 400);
	const venue = typeof body.venue === 'string' ? body.venue : null;

	try {
		await addToQueue({ tmdbId, scheduledDate: date, venue });
		return json({ ok: true }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to add', 500);
	}
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const tmdbId = Number.parseInt(url.searchParams.get('tmdbId') ?? '', 10);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);

	try {
		const removed = await removeFromQueue(tmdbId);
		if (!removed) return apiError('not queued', 404);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to remove', 500);
	}
};
