// Upload .fit/.gpx/.tcx files and store them as activities — ACTIVITIES.md §4
// step 2 as an endpoint, next to the Strava sync (step 3). Owner only.
//
// This is the drop folder (scripts/add-activities.mjs) over HTTP: the same
// parse → dedupe → score → store pipeline (src/lib/activity-ingest.ts), so an
// uploaded FIT is stored identically to a dropped one (provider 'file',
// fidelity 90, per-sport default gear). It exists because the drop folder only
// runs on the machine with the files; this runs anywhere the owner is signed
// in.
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { ingestFiles, isParseable, isSport, type UploadFile } from '../../../lib/activity-ingest';

export const prerender = false;

// A batch of tracks is not small (a FIT with streams is often 1–3 MB), so allow
// a generous body. Vercel Functions accept up to 100 MB; this caps the count so
// one request can't try to hold hundreds of files in memory at once.
const MAX_FILES = 25;

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return apiError('expected multipart/form-data', 400);
	}

	const uploads: UploadFile[] = [];
	const rejected: string[] = [];
	for (const value of form.getAll('files')) {
		if (!(value instanceof File)) continue;
		if (!isParseable(value.name)) {
			rejected.push(value.name);
			continue;
		}
		uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
	}

	if (!uploads.length) {
		return apiError(rejected.length ? `no .fit/.gpx/.tcx files (got ${rejected.join(', ')})` : 'no files uploaded', 400);
	}
	if (uploads.length > MAX_FILES) {
		return apiError(`too many files (${uploads.length}); ${MAX_FILES} at a time`, 400);
	}

	const sport = form.get('sport');
	if (typeof sport === 'string' && sport && !isSport(sport)) {
		return apiError(`unknown sport ${sport}`, 400);
	}
	const gearName = form.get('gear');

	try {
		const result = await ingestFiles(uploads, {
			sport: typeof sport === 'string' && isSport(sport) ? sport : undefined,
			gearName: typeof gearName === 'string' && gearName ? gearName : undefined,
			noGear: form.get('noGear') === '1',
		});
		// Files with an extension we don't parse are worth telling the owner about,
		// but they don't fail the batch — surface them alongside the results.
		return json(rejected.length ? { ...result, rejected } : result);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'import failed', 500);
	}
};
