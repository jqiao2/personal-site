// The flight poster's only call to the site, once per poll: it POSTs its status
// and city list, and the reply carries its settings and any city the owner asked
// it to show. Machine-to-machine, so a bearer token (FLIGHT_POSTER_TOKEN, also in
// the board's config.json as site_token) instead of the owner cookie.
import type { APIRoute } from 'astro';
import { checkSyncToken } from '../../../lib/auth';
import { syncBody } from '../../../lib/flight-poster';
import { syncBoard } from '../../../lib/flight-poster-db';
import { apiError, json } from '../../../lib/http';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	const auth = checkSyncToken(request.headers.get('authorization'), import.meta.env.FLIGHT_POSTER_TOKEN);

	if (auth === 'unconfigured') return apiError('FLIGHT_POSTER_TOKEN is not set on the server', 503);

	if (auth === 'unauthorized') return apiError('unauthorized', 401);

	const body = syncBody.safeParse(await request.json().catch(() => null));

	if (!body.success) return apiError('expected {status, cities}');

	try {
		return json(await syncBoard(body.data.status, body.data.cities), 200, { 'cache-control': 'no-store' });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'sync failed', 500);
	}
};
