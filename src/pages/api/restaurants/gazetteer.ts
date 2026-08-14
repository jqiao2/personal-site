import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { searchGazetteer } from '../../../lib/gazetteer';

export const prerender = false;

// GET /api/restaurants/gazetteer?q=…&lat=…&lng=…  (owner only)
//
// The composer's autocomplete, answered from our own imported copies rather
// than from a live geocoder. Same job the Nominatim route does, with three
// differences that are the whole reason it exists: it is instant, it needs no
// network beyond this site, and it knows the places OpenStreetMap has never
// heard of — which in this city is most of them.
//
// Owner-gated to match the geocode route beside it. Nothing here is secret, but
// only the owner has a composer to type into.
export const GET: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const q = url.searchParams.get('q') ?? '';
	if (q.trim().length < 2) return json({ hits: [] });

	// Number(null) is 0, and 0,0 is a real place in the Gulf of Guinea — so the
	// parameters have to be tested for presence, not just for being finite, or
	// every unranked search sorts by distance from the Atlantic.
	const rawLat = url.searchParams.get('lat');
	const rawLng = url.searchParams.get('lng');
	const lat = rawLat == null ? Number.NaN : Number(rawLat);
	const lng = rawLng == null ? Number.NaN : Number(rawLng);
	const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

	try {
		return json({ hits: await searchGazetteer({ q, near }) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'search failed', 500);
	}
};
