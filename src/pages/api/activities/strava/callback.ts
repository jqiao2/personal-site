// Strava OAuth callback — owner only. Strava sends the browser here with a
// `code` (or an `error` if the owner declined); we swap the code for the first
// token pair, store it, and bounce back to the settings page.
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { apiError } from '../../../../lib/http';
import { exchangeCode } from '../../../../lib/strava';

export const prerender = false;

const back = (params: string) =>
	new Response(null, { status: 302, headers: { location: `/activities/settings?${params}` } });

export const GET: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const url = new URL(request.url);

	const error = url.searchParams.get('error');
	if (error) return back(`error=${encodeURIComponent(error)}`);

	const code = url.searchParams.get('code');
	if (!code) return back('error=no_code');

	// activity:read_all is required to read private rides; a partial grant is
	// worse than none because the sync would then silently miss most of them.
	const scope = url.searchParams.get('scope') ?? '';
	if (!scope.includes('activity:read_all')) return back('error=missing_scope');

	try {
		await exchangeCode(code);
		return back('connected=1');
	} catch (e) {
		return back(`error=${encodeURIComponent(e instanceof Error ? e.message : 'exchange_failed')}`);
	}
};
