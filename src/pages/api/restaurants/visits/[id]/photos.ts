import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../../lib/auth';
import { json, apiError } from '../../../../../lib/http';
import { addPhotos, reorderPhotos, uploadPhoto } from '../../../../../lib/restaurants';

export const prerender = false;

/**
 * 4 MB, and it is a ceiling inherited rather than chosen.
 *
 * Vercel refuses a serverless request body over 4.5 MB with a platform-level
 * 413 — the function is never entered, so a limit above that would be a number
 * this file states and cannot enforce, and the browser would get an
 * unexplained HTML error page instead of the message below. The composer
 * downscales to a 1600 px long edge before sending and posts one photograph
 * per request, so a real upload arrives at a few hundred kilobytes; this
 * catches what skipped that path — an undecodable format the composer passed
 * through untouched, or a client that is not the composer.
 */
const MAX_BYTES = 4 * 1024 * 1024;

// POST /api/restaurants/visits/:id/photos  (owner only)
//
// multipart/form-data: one or more `photo` files, plus optional parallel
// `caption`, `width` and `height` fields (same order as the files). Dimensions
// come from the browser, which has already decoded the image to preview it —
// measuring them again on the server would mean decoding every upload twice.
export const POST: APIRoute = async ({ params, request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const visitId = Number(params.id);
	if (!Number.isInteger(visitId) || visitId <= 0) return apiError('bad id', 400);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return apiError('expected multipart/form-data', 400);
	}

	const files = form.getAll('photo').filter((f): f is File => f instanceof File && f.size > 0);
	if (files.length === 0) return apiError('no photos in the request', 400);

	const captions = form.getAll('caption').map(String);
	const widths = form.getAll('width').map(String);
	const heights = form.getAll('height').map(String);

	for (const file of files) {
		if (file.size > MAX_BYTES) return apiError(`${file.name} is larger than 4 MB`, 413);
		if (!file.type.startsWith('image/')) return apiError(`${file.name} is not an image`, 415);
	}

	try {
		const stored = [];
		for (let i = 0; i < files.length; i++) {
			const path = await uploadPhoto(visitId, files[i], files[i].name);
			stored.push({
				storagePath: path,
				caption: captions[i] ?? null,
				width: toInt(widths[i]),
				height: toInt(heights[i]),
			});
		}
		// The new ids ride back so the composer can place a photograph where it
		// was dropped: it holds the whole arrangement and sends it to PATCH.
		const ids = await addPhotos(visitId, stored);
		return json({ added: stored.length, ids }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to store the photographs', 500);
	}
};

// PATCH /api/restaurants/visits/:id/photos  (owner only)
//
// { order: [photoId, …] } — the visit's photographs in the order they should
// read. The whole list, not a single move: the composer already knows the
// arrangement it wants, and sending it entire is what makes the result
// independent of how many nudges it took to get there.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const visitId = Number(params.id);
	if (!Number.isInteger(visitId) || visitId <= 0) return apiError('bad id', 400);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	if (!Array.isArray(body.order)) return apiError('order must be an array of photo ids', 400);
	const order = body.order.map(Number);
	if (order.some((id) => !Number.isInteger(id) || id <= 0)) return apiError('bad photo id', 400);
	if (new Set(order).size !== order.length) return apiError('order repeats a photo', 400);

	try {
		await reorderPhotos(visitId, order);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to rearrange the photographs', 500);
	}
};

function toInt(v: string | undefined): number | null {
	if (!v) return null;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}
