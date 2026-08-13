import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { geocode } from '../../../lib/geocode';

export const prerender = false;

// GET /api/restaurants/geocode?q=wu's+wonton+king  (owner only)
//
// Owner-gated even though it reads nothing private: it spends a shared,
// volunteer-run service's request budget under this site's name, and only the
// owner has any reason to call it. A public endpoint here would be an open
// proxy pointed at Nominatim with our User-Agent on it.
export const GET: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const q = url.searchParams.get('q') ?? '';
	if (q.trim().length < 3) return json({ hits: [] });

	try {
		return json({ hits: await geocode(q) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'geocode failed', 502);
	}
};
