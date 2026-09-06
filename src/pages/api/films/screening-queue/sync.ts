import type { APIRoute } from 'astro';
import { syncFromCalendar } from '../../../../lib/screening-queue';
import { isConfigured } from '../../../../lib/google-calendar';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';

export const prerender = false;

// POST /api/films/screening-queue/sync → (owner) pull the Movies calendar into
// the queue, resolving AMC-style events to TMDB films.
export const POST: APIRoute = async ({ cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	if (!isConfigured()) return apiError('Google Calendar is not configured', 503);
	try {
		return json(await syncFromCalendar());
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'sync failed', 500);
	}
};
