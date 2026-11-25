// Pull the Letterboxd watchlist into the site's. Two callers, as with the recipes sync:
//   GET  — the daily Vercel cron (`Authorization: Bearer $CRON_SECRET`).
//   POST — the owner, by hand. `?force=1` lets through a run that would remove
//          more films than the safety limit in lib/letterboxd-watchlist.ts.
import type { APIRoute } from 'astro';
import { isCron, requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';
import { syncLetterboxdWatchlist } from '../../../../lib/letterboxd-watchlist';

export const prerender = false;

async function run(request: Request, cookies: Parameters<APIRoute>[0]['cookies'], force: boolean): Promise<Response> {
	if (!isCron(request) && !(await requireOwner(cookies))) return apiError('unauthorized', 401);

	try {
		return json(await syncLetterboxdWatchlist(force), 200, { 'cache-control': 'no-store' });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'sync failed', 500);
	}
}

export const GET: APIRoute = ({ request, cookies }) => run(request, cookies, false);

export const POST: APIRoute = ({ request, cookies, url }) => run(request, cookies, url.searchParams.get('force') === '1');
