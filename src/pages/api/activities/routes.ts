import type { APIRoute } from 'astro';
import { listRoutePolylines } from '../../../lib/activities';
import { requireOwner } from '../../../lib/auth';
import { apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/activities/routes → { routes: [{ family, polyline }, …] }
// (family is src/lib/sports.ts's SportFamily — the axis the heatmap filters on.)
//
// Every outdoor track the reader may see, for /activities/heatmap. Fetched by the page
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

type Cached = { at: number; body: string };

const cached: { owner: Cached | null; visitor: Cached | null } = { owner: null, visitor: null };

// TWO BODIES, NEVER ONE. The owner gets everything; a visitor gets public
// activities from before HEATMAP_PUBLIC_BEFORE (listRoutePolylines applies that
// at the query). Each has its own slot above, because a shared one would serve
// the next reader whichever version happened to be built first. The owner's
// header is private/no-store for the same reason, one layer out; a visitor's is
// an hour at the CDN, so an activity made private leaves the map the same day.
export const GET: APIRoute = async ({ cookies }) => {
	const isOwner = await requireOwner(cookies);
	const slot = isOwner ? 'owner' : 'visitor';

	try {
		let entry = cached[slot];

		if (!entry || Date.now() - entry.at > TTL_MS) {
			entry = { at: Date.now(), body: JSON.stringify({ routes: await listRoutePolylines(isOwner) }) };
			cached[slot] = entry;
		}

		return new Response(entry.body, {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': isOwner ? 'private, no-store' : 'public, max-age=0, s-maxage=3600',
				vary: 'Cookie',
			},
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to load routes', 500);
	}
};
