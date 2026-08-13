import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';
import { deletePhoto } from '../../../../lib/restaurants';

export const prerender = false;

// DELETE /api/restaurants/photos/:id  (owner only) — drop a photograph and the
// object behind it. Hard delete: unlike a visit, there is nothing left to read
// once the file is gone, so a soft-deleted row would only be a leak.
export const DELETE: APIRoute = async ({ params, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);
	try {
		await deletePhoto(id);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to delete the photograph', 500);
	}
};
