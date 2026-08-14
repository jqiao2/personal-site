import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { createPlace, isPriceBand, searchPlaces, type PriceBand } from '../../../lib/restaurants';

export const prerender = false;

// GET /api/restaurants/places?q=xi'an → the composer's place autocomplete.
export const GET: APIRoute = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	try {
		return json({ places: await searchPlaces(q) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'search failed', 500);
	}
};

// POST /api/restaurants/places  (owner only) — add a place.
//
// With `toTry: true` this is the "add to to-try" composer: a place with no
// visits, which is exactly what a place you mean to go to is. Without it, a
// bare place record you can log against later.
export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) return apiError('name is required', 400);
	if (body.priceBand != null && !isPriceBand(body.priceBand)) {
		return apiError('priceBand must be $, $$, $$$ or $$$$', 400);
	}

	try {
		const place = await createPlace({
			name,
			cuisines: Array.isArray(body.cuisines) ? body.cuisines.map(String) : [],
			priceBand: (body.priceBand as PriceBand | null) ?? null,
			neighborhood: text(body.neighborhood),
			city: text(body.city) ?? undefined,
			stateRegion: text(body.stateRegion),
			country: text(body.country) ?? undefined,
			lat: num(body.lat),
			lng: num(body.lng),
			googlePlaceId: text(body.googlePlaceId),
			websiteUrl: text(body.websiteUrl),
			yelpUrl: text(body.yelpUrl),
			beliUrl: text(body.beliUrl),
			toTryReason: text(body.toTryReason),
			trip: Boolean(body.trip),
			toTryTags: Array.isArray(body.toTryTags) ? body.toTryTags.map(String) : [],
			toTry: Boolean(body.toTry),
		});
		return json({ place }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to add the place', 500);
	}
};

function text(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t === '' ? null : t;
}

function num(v: unknown): number | null {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
