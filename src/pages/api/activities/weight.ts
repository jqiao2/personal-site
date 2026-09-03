// Weigh-in ingest — the smart scale's body mass, pushed from an iOS Shortcut
// that reads Apple Health "Body Mass" samples.
//
// Machine-to-machine like /api/books/sync: the caller is a phone automation
// with no cookie and no login page, so it carries a static bearer token
// (WEIGHT_SYNC_TOKEN) instead of the owner session. Same check as the reading
// sync, pointed at a different secret.
//
// Weight lands in body_weight (0059), NOT athlete_thresholds: a weight-only
// threshold row would blank FTP/LTHR for that day's exertion. See the migration.
//
// Takes one reading OR a batch, so the daily automation and a full history
// backfill are the same endpoint. Accepts any of:
//   { weight, unit?, date? }                       — one reading
//   [ { weight, date }, … ]                         — a batch
//   { weights: [ { weight, date }, … ] }            — a batch, named
// unit defaults to 'lb' (US-locale Health samples come through in pounds);
// date defaults to today in UTC, so the Shortcut should send the device-local
// date. Validation, kg conversion and the one-row-per-day rule live in
// parseWeighIns (src/lib/athlete.ts), tested in scripts/athlete.test.mjs.
import type { APIRoute } from 'astro';
import { checkSyncToken } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { listWeighIns, upsertWeighIns } from '../../../lib/activities';
import { parseWeighIns, flagOutliers, type WeighInInput } from '../../../lib/athlete';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	switch (checkSyncToken(request.headers.get('authorization'), import.meta.env.WEIGHT_SYNC_TOKEN)) {
		case 'ok':
			break;
		case 'unconfigured':
			return apiError('weight sync is not configured: WEIGHT_SYNC_TOKEN is not set', 503);
		default:
			return apiError('unauthorized', 401);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}

	// Normalise the three accepted shapes down to a list of items.
	const items: WeighInInput[] = Array.isArray(body)
		? (body as WeighInInput[])
		: body && typeof body === 'object' && Array.isArray((body as { weights?: unknown }).weights)
			? ((body as { weights: WeighInInput[] }).weights)
			: body && typeof body === 'object'
				? [body as WeighInInput]
				: [];

	const today = new Date().toISOString().slice(0, 10);
	const parsed = parseWeighIns(items, today);
	if ('error' in parsed) return apiError(parsed.error, 400);

	try {
		// Flag scale mis-reads against the accepted history before writing, so a
		// spurious reading is stored but kept out of the graph and out of the
		// baseline the next reading is judged against.
		const rows = flagOutliers(await listWeighIns(), parsed.rows);
		const count = await upsertWeighIns(rows);
		const ignored = rows.filter((r) => r.ignored).length;
		return json({ ok: true, count, ignored });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'weight sync failed', 500);
	}
};
