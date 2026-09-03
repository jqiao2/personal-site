// Weigh-in ingest — the smart scale's daily body mass, pushed from an iOS
// Shortcut that reads the latest Apple Health "Body Mass" sample.
//
// Machine-to-machine like /api/books/sync: the caller is a phone automation
// with no cookie and no login page, so it carries a static bearer token
// (WEIGHT_SYNC_TOKEN) instead of the owner session. Same check as the reading
// sync, pointed at a different secret — a separate device gets a separate,
// independently-revocable token.
//
// Weight lands in body_weight (0059), NOT athlete_thresholds: a weight-only
// threshold row would blank FTP/LTHR for that day's exertion. See the migration.
import type { APIRoute } from 'astro';
import { checkSyncToken } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { upsertWeighIn } from '../../../lib/activities';
import { LB_PER_KG } from '../../../lib/athlete';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/activities/weight  { weight, unit?: 'kg'|'lb', date?: 'YYYY-MM-DD' }
//
// unit defaults to 'lb' — the athlete enters and reads weight in pounds, and a
// US-locale Health sample comes through the Shortcut in pounds. Pass unit:'kg'
// (or send weight already in kg) to be explicit. date defaults to today in UTC;
// the Shortcut should send the device-local date so a late-night weigh-in isn't
// filed on the wrong day.
export const POST: APIRoute = async ({ request }) => {
	switch (checkSyncToken(request.headers.get('authorization'), import.meta.env.WEIGHT_SYNC_TOKEN)) {
		case 'ok':
			break;
		case 'unconfigured':
			return apiError('weight sync is not configured: WEIGHT_SYNC_TOKEN is not set', 503);
		default:
			return apiError('unauthorized', 401);
	}

	let b: Record<string, unknown>;
	try {
		b = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const weight = Number(b.weight);
	if (!Number.isFinite(weight) || weight <= 0) return apiError('weight must be a positive number', 400);

	const unit = (b.unit ?? 'lb') as string;
	if (unit !== 'lb' && unit !== 'kg') return apiError("unit must be 'lb' or 'kg'", 400);
	const weight_kg = unit === 'lb' ? weight / LB_PER_KG : weight;
	// The scale can't read a person outside this band; anything here is a unit
	// slip (kg sent as lb, or a stray reading), and the DB check would reject it.
	if (weight_kg < 20 || weight_kg > 300) return apiError('weight out of range — check the unit', 400);

	const measured_on = b.date == null ? new Date().toISOString().slice(0, 10) : String(b.date);
	if (!DATE_RE.test(measured_on)) return apiError('date must be YYYY-MM-DD', 400);

	try {
		await upsertWeighIn(measured_on, weight_kg, typeof b.source === 'string' ? b.source : 'apple_health');
		return json({ ok: true, measured_on, weight_kg });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'weight sync failed', 500);
	}
};
