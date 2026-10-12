import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../../lib/auth';
import { apiError } from '../../../../../lib/http';
import { setLinks } from '../../../../../lib/activity-meals';

export const prerender = false;

// POST /api/restaurants/visits/:id/activities  (owner only)
//
// A plain form post from the meal page's owner box: the ticked `activity_id`
// boxes become exactly the set linked to this meal, then back to the page.
export const POST: APIRoute = async ({ params, request, cookies, redirect }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number(params.id);

	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);

	const form = await request.formData();

	try {
		await setLinks('visit_id', id, form.getAll('activity_id').map(Number));
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to link activities', 500);
	}

	return redirect(`/restaurants/diary/${id}`, 303);
};
