// Pull recipes.json from the recipes repo. Two callers, as with the Strava sync:
//   GET  — the daily Vercel cron (`Authorization: Bearer $CRON_SECRET`).
//   POST — the owner's Sync button on /recipes.
import type { APIRoute } from 'astro';
import { isCron, requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { syncRecipes } from '../../../lib/recipes-db';

export const prerender = false;

async function run(request: Request, cookies: Parameters<APIRoute>[0]['cookies']): Promise<Response> {
	if (!isCron(request) && !(await requireOwner(cookies))) return apiError('unauthorized', 401);

	try {
		return json(await syncRecipes(), 200, { 'cache-control': 'no-store' });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'sync failed', 500);
	}
}

export const GET: APIRoute = ({ request, cookies }) => run(request, cookies);

export const POST: APIRoute = ({ request, cookies }) => run(request, cookies);
