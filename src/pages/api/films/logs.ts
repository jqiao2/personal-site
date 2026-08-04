import type { APIRoute } from 'astro';
import { logFilm, listLogs } from '../../../lib/films';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/films/logs?limit=50&offset=0  → public list of watches (newest first,
// soft-deleted excluded).
export const GET: APIRoute = async ({ url }) => {
	const limit = clamp(Number.parseInt(url.searchParams.get('limit') ?? '50', 10), 1, 100, 50);
	const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

	try {
		const logs = await listLogs(limit, offset);
		return json({ logs });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list logs', 500);
	}
};

// POST /api/films/logs  (owner only) — "log a film".
// Always marks the film watched; creates a dated diary log only when the entry
// has content (rating/like/rewatch/review/tags/friends). Returns { watchedOnly, logId }.
// Body: { tmdbId, watchedDate?, loggedDate?, rating?, reviewText?, rewatched?,
//         liked?, tags?, friends? }
// `loggedDate` is the client's own calendar day — the diary date. Omitted, the
// server falls back to the day in SITE_TZ.
export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}

	const tmdbId = Number(body.tmdbId);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) return apiError('tmdbId is required', 400);

	const rating = body.rating == null ? null : Number(body.rating);
	if (rating != null && !isValidRating(rating)) {
		return apiError('rating must be between 0.5 and 5.0 in 0.5 steps', 400);
	}

	try {
		const result = await logFilm({
			tmdbId,
			watchedDate: asDateString(body.watchedDate),
			loggedDate: asDateString(body.loggedDate),
			rating,
			reviewText: asText(body.reviewText),
			rewatched: Boolean(body.rewatched),
			liked: Boolean(body.liked),
			tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
			friends: Array.isArray(body.friends) ? body.friends.map(String) : undefined,
			medium: asText(body.medium),
			venue: asText(body.venue),
			format: asText(body.format),
		});
		return json(result, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to log film', 500);
	}
};

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function isValidRating(r: number): boolean {
	return Number.isFinite(r) && r >= 0.5 && r <= 5 && Number.isInteger(r * 2);
}

function asDateString(v: unknown): string | null {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
	return v;
}

function asText(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}
