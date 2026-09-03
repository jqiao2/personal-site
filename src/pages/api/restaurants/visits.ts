import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import {
	createPlace,
	createVisit,
	listRecentVisits,
	updatePlace,
} from '../../../lib/restaurants';

export const prerender = false;

// GET /api/restaurants/visits?limit=20 → the public diary, newest first.
export const GET: APIRoute = async ({ url }) => {
	const raw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
	const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 20;
	try {
		return json({ visits: await listRecentVisits(limit) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to list visits', 500);
	}
};

// POST /api/restaurants/visits  (owner only) — "log a meal".
//
// Takes either an existing `restaurantId` or a `place` object to create one, so
// the composer's two paths — picking a place you've been to and typing a place
// you haven't — are one request rather than two round trips with a half-created
// restaurant in between if the second fails.
//
// Body: { restaurantId? , place?: { name, cuisines?, neighborhood?,
//         city?, stateRegion?, country?, lat?, lng? },
//         visitedOn?, rating?, verdict?, hearted?, revisit?, friends?, review?, tags? }
export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const rating = body.rating == null ? null : Number(body.rating);
	if (rating != null && !isValidRating(rating)) {
		return apiError('rating must be between 0.5 and 5.0 in half steps', 400);
	}
	const verdict = body.verdict == null ? null : Number(body.verdict);
	if (verdict != null && !(Number.isInteger(verdict) && verdict >= 0 && verdict <= 5)) {
		return apiError('verdict must be a rank between 0 and 5', 400);
	}
	const visitedOn = asDate(body.visitedOn);
	if (body.visitedOn != null && visitedOn == null) {
		return apiError('visitedOn must be YYYY-MM-DD', 400);
	}

	try {
		const restaurantId = await resolveRestaurant(body);
		if (restaurantId == null) return apiError('restaurantId or place.name is required', 400);

		const id = await createVisit({
			restaurantId,
			visitedOn,
			rating,
			verdict,
			hearted: Boolean(body.hearted),
			revisit: Boolean(body.revisit),
			friends: asList(body.friends),
			review: asText(body.review),
			privateNote: asText(body.privateNote),
			tags: asList(body.tags),
		});
		return json({ id, restaurantId }, 201);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to log the visit', 500);
	}
};

/**
 * The place this visit is at: an existing id, or a new row built from `place`.
 *
 * The only thing a visit writes onto a place it did not create is the trip
 * answer, which the composer asks because a meal is when you find out. Price
 * used to come through here too; it is edited on the restaurant now, since one
 * column shared by every meal cannot be a per-meal answer.
 */
async function resolveRestaurant(body: Record<string, unknown>): Promise<number | null> {
	const place = (body.place ?? null) as Record<string, unknown> | null;
	const existing = body.restaurantId == null ? null : Number(body.restaurantId);

	if (existing != null && Number.isInteger(existing) && existing > 0) {
		// The trip answer only. The composer is logging a meal at a place that
		// already exists, and is not renaming or repricing it.
		const edit = typeof place?.trip === 'boolean' ? { trip: place.trip } : {};
		if (Object.keys(edit).length > 0) await updatePlace(existing, edit);
		return existing;
	}

	const name = typeof place?.name === 'string' ? place.name.trim() : '';
	if (!name) return null;
	const created = await createPlace({
		name,
		cuisines: asList(place?.cuisines),
		neighborhood: asText(place?.neighborhood),
		city: asText(place?.city) ?? undefined,
		stateRegion: asText(place?.stateRegion),
		country: asText(place?.country) ?? undefined,
		lat: asNumber(place?.lat),
		lng: asNumber(place?.lng),
		trip: Boolean(place?.trip),
	});
	return created.id;
}

function isValidRating(r: number): boolean {
	return Number.isFinite(r) && r >= 0.5 && r <= 5 && Number.isInteger(r * 2);
}

function asDate(v: unknown): string | null {
	return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function asText(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t === '' ? null : t;
}

function asList(v: unknown): string[] {
	return Array.isArray(v) ? v.map(String) : [];
}

function asNumber(v: unknown): number | null {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
