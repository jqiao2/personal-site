// Pull new rides from Strava. Two callers:
//   POST — the owner's "Sync now" button (owner session cookie).
//   GET  — the daily Vercel cron, which carries `Authorization: Bearer
//          $CRON_SECRET` (Vercel adds it automatically when CRON_SECRET is set).
//
// Either credential is accepted; the work is identical.
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';
import { syncStrava } from '../../../../lib/strava-sync';

export const prerender = false;

function isCron(request: Request): boolean {
	const secret = import.meta.env.CRON_SECRET;
	if (!secret) return false;
	const header = request.headers.get('authorization');
	return header === `Bearer ${secret}`;
}

async function run(request: Request, cookies: Parameters<APIRoute>[0]['cookies']): Promise<Response> {
	if (!isCron(request) && !(await requireOwner(cookies))) return apiError('unauthorized', 401);
	try {
		const result = await syncStrava();
		return json(result);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'sync failed', 500);
	}
}

export const GET: APIRoute = ({ request, cookies }) => run(request, cookies);
export const POST: APIRoute = ({ request, cookies }) => run(request, cookies);
