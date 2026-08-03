import type { APIRoute } from 'astro';
import { checkSyncToken } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { getSyncCursor, ingestSync, parseSyncPayload, SyncPayloadError } from '../../../lib/reading';

export const prerender = false;

// The KOReader ingest endpoint. Both verbs authenticate with
// `Authorization: Bearer $READING_SYNC_TOKEN` — the caller is a Kindle, so
// there's no cookie and no login page, unlike the film routes' owner session.

// POST /api/reading/sync — take a batch of books + page-turn sessions.
//
// Idempotent: the plugin resends overlapping ranges after any failed or partial
// sync, and `sessions_inserted` coming back lower than `sessions_received` is
// the unique constraint doing its job, not an error.
export const POST: APIRoute = async ({ request }) => {
	if (!checkSyncToken(request.headers.get('authorization'))) return apiError('unauthorized', 401);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}

	try {
		const payload = parseSyncPayload(body);
		const result = await ingestSync(payload);
		return json({ ok: true, ...result });
	} catch (e) {
		if (e instanceof SyncPayloadError) return apiError(e.message, e.status);
		return apiError(e instanceof Error ? e.message : 'reading sync failed', 500);
	}
};

// GET /api/reading/sync?device=kindle-pw5 — resume cursor, so the plugin can
// send only what came after and skip re-uploading months of history.
export const GET: APIRoute = async ({ request, url }) => {
	if (!checkSyncToken(request.headers.get('authorization'))) return apiError('unauthorized', 401);

	const device = url.searchParams.get('device')?.trim();
	if (!device) return apiError('device is required', 400);

	try {
		return json(await getSyncCursor(device));
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to read sync cursor', 500);
	}
};
