import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { reverseGeocode } from '../../../lib/geocode';

export const prerender = false;

// GET /api/restaurants/reverse?lat=40.6452&lng=-74.0102  (owner only)
//
// What is at this point — the other half of the trip a plus code starts.
//
// A plus code, a pasted coordinate pair and a point pulled out of a share link
// all arrive as two numbers and nothing else. Two numbers put a pin on the map
// and say nothing about what neighbourhood, borough or city the pin is in, so
// until this existed a restaurant placed by plus code was placed exactly and
// described not at all — the words had to be typed in by hand beside a location
// the geocoder already knew.
//
// Owner-gated for the same reason `geocode` is, and it is the same fence: it
// spends a shared, volunteer-run service's request budget under this site's
// name. It also shares that route's pacer, because `reverseGeocode` lives in
// the same module as `geocode` and Nominatim's one-a-second budget is per
// service rather than per endpoint.
export const GET: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const lat = Number(url.searchParams.get('lat'));
	const lng = Number(url.searchParams.get('lng'));
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		return apiError('lat and lng are required', 400);
	}
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
		return apiError('lat/lng out of range', 400);
	}

	try {
		// null is a normal answer, not an error: plenty of points have no address
		// and the caller shows that as "no words for this point" rather than a
		// failure. The place still saves, with its coordinates.
		return json({ hit: await reverseGeocode(lat, lng) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'reverse geocode failed', 502);
	}
};
