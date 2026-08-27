// Start the Strava OAuth handshake — owner only. Redirects the browser to
// Strava's consent screen; Strava sends it back to ./callback with a code.
//
// The redirect_uri is built from this request's own origin so it matches
// whatever host the owner is actually on, and it must fall under the
// "Authorization Callback Domain" set on the Strava app
// (https://www.strava.com/settings/api).
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { apiError } from '../../../../lib/http';
import { authorizeUrl } from '../../../../lib/strava';

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const redirectUri = `${new URL(request.url).origin}/api/activities/strava/callback`;
	return new Response(null, { status: 302, headers: { location: authorizeUrl(redirectUri) } });
};
