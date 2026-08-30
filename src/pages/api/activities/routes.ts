import type { APIRoute } from 'astro';
import { listRoutePolylines } from '../../../lib/activities';
import { requireOwner } from '../../../lib/auth';
import { apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/activities/routes → { routes: [{ family, polyline }, …] }
// (family is src/lib/sports.ts's SportFamily — the axis the heatmap filters on.)
//
// Every outdoor track, all-time, for /activities/heatmap. Fetched by the page
// rather than inlined into it: this is the largest payload the section serves,
// and the map, the geolocation prompt and the shell around them are all
// interactive before it lands.
//
// MEMOISED IN THE INSTANCE. Building the body reads the whole collection and
// runs RDP over five million points — about four seconds. The answer only
// changes when an import runs, so a warm instance serves it from memory and
// the cache header covers everything in front of it.
// ponytail: a plain module-scope cache, per instance; if this ever needs to be
// shared or pre-warmed, it belongs behind the CDN or in a build step, not in a
// bigger version of this.
const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; body: string } | null = null;

// OWNER ONLY, and the cache above is why the check has to be the first thing
// in the handler rather than a filter inside listRoutePolylines: one body is
// memoised per instance, so if a visitor's request could ever populate it the
// next reader would be served whichever version happened to be built first.
// The header is private/no-store for the same reason, one layer out.
export const GET: APIRoute = async ({ cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	try {
		if (!cached || Date.now() - cached.at > TTL_MS) {
			cached = { at: Date.now(), body: JSON.stringify({ routes: await listRoutePolylines(true) }) };
		}
		return new Response(cached.body, {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'private, no-store',
			},
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to load routes', 500);
	}
};
