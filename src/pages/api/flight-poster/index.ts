// The admin page's form posts. `action` picks one:
//   config — save the settings form; the board picks it up on its next poll
//   show   — queue a city (`slug`) for the next poll
//   cancel — drop the queued city
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { parseConfigForm } from '../../../lib/flight-poster';
import { saveConfig, setPendingShow } from '../../../lib/flight-poster-db';
import { apiError } from '../../../lib/http';

export const prerender = false;

const BACK = '/projects/flight-poster/admin';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const form = await request.formData();

	const action = form.get('action');

	if (action === 'config') {
		const parsed = parseConfigForm(form);

		if ('error' in parsed) return apiError(parsed.error);

		await saveConfig(parsed.config);

		return redirect(`${BACK}#settings`, 303);
	}

	if (action === 'show') {
		const slug = form.get('slug')?.toString();

		if (!slug) return apiError('missing slug');

		await setPendingShow(slug);

		return redirect(`${BACK}#library`, 303);
	}

	if (action === 'cancel') {
		await setPendingShow(null);

		return redirect(`${BACK}#library`, 303);
	}

	return apiError('unknown action');
};
