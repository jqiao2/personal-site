import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../../lib/auth';
import { json, apiError } from '../../../../../lib/http';
import { addPhotos, uploadPhoto } from '../../../../../lib/restaurants';

export const prerender = false;

/** 12 MB. Comfortably over a phone photo, well under the serverless body cap. */
const MAX_BYTES = 12 * 1024 * 1024;

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
		if (file.size > MAX_BYTES) return apiError(`${file.name} is larger than 12 MB`, 413);
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
		await addPhotos(visitId, stored);
		return json({ added: stored.length }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to store the photographs', 500);
	}
};

function toInt(v: string | undefined): number | null {
	if (!v) return null;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}
