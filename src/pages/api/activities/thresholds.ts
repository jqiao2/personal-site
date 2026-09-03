// Owner-only writes for athlete_thresholds — the numbers every exertion score
// is measured against (src/lib/exertion.ts §"the cascade"). Behind
// /activities/athlete.
//
// PUT rather than POST+PATCH: effective_from is the table's versioning key and
// has a unique index on it, so "save the numbers as of this date" is one
// upsert whether or not that date already has a row. Editing a row in the
// table and adding a new one are the same call, which is also what stops the
// page from silently creating a second row for a date that already has one.
//
// NOTE ON STALENESS. Existing activities keep the score they were ingested
// with; changing a threshold does not re-run them. `scripts/recompute-exertion.mjs`
// is the thing that does, deliberately offline — see its header.
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { supabaseAdmin } from '../../../lib/supabase';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The measurable fields and the range each is allowed to sit in. The bounds
 *  are deliberately generous — they exist to catch a unit slip (a weight typed
 *  in pounds, an FTP typed as a percentage), not to police fitness. */
const FIELDS = {
	ftp_w: { min: 50, max: 600, int: true },
	lthr_bpm: { min: 80, max: 220, int: true },
	max_hr: { min: 100, max: 230, int: true },
	rest_hr: { min: 25, max: 100, int: true },
	threshold_pace_s_per_km: { min: 120, max: 900, int: false },
	css_pace_s_per_100m: { min: 45, max: 300, int: false },
	weight_kg: { min: 30, max: 200, int: false },
	height_cm: { min: 100, max: 230, int: false },
} as const;

type Field = keyof typeof FIELDS;

// PUT — save the numbers in force from a date. { effectiveFrom, ftp_w, … }
// Any field present and blank is cleared; fields absent are left alone on an
// existing row (and null on a new one).
export const PUT: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let b: Record<string, unknown>;
	try {
		b = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const effective_from = b.effectiveFrom;
	if (typeof effective_from !== 'string' || !DATE_RE.test(effective_from)) {
		return apiError('effectiveFrom must be YYYY-MM-DD', 400);
	}

	const row: Record<string, unknown> = { effective_from };
	for (const [key, range] of Object.entries(FIELDS) as [Field, (typeof FIELDS)[Field]][]) {
		if (!(key in b)) continue;
		const raw = b[key];
		if (raw == null || raw === '') {
			row[key] = null;
			continue;
		}
		const n = Number(raw);
		if (!Number.isFinite(n)) return apiError(`${key} must be a number`, 400);
		if (n < range.min || n > range.max) {
			return apiError(`${key} must be between ${range.min} and ${range.max}`, 400);
		}
		row[key] = range.int ? Math.round(n) : n;
	}

	if (Object.keys(row).length === 1) return apiError('nothing to save', 400);

	const { error } = await supabaseAdmin
		.from('athlete_thresholds')
		.upsert(row, { onConflict: 'effective_from' });
	if (error) return apiError(`could not save: ${error.message}`, 500);
	return json({ ok: true });
};

// DELETE — drop a row entered by mistake. { id }
export const DELETE: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let b: Record<string, unknown>;
	try {
		b = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const id = Number(b.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);

	const { error } = await supabaseAdmin.from('athlete_thresholds').delete().eq('id', id);
	if (error) return apiError(`could not delete: ${error.message}`, 500);
	return json({ ok: true });
};
