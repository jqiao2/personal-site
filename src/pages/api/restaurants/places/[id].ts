import type { APIRoute } from 'astro';
import { requireOwner } from '../../../../lib/auth';
import { json, apiError } from '../../../../lib/http';
import {
	isPriceBand,
	removeFromToTry,
	setFavoriteRank,
	setPlaceHearted,
	updatePlace,
	type PriceBand,
} from '../../../../lib/restaurants';

export const prerender = false;

// PATCH /api/restaurants/places/:id  (owner only)
//
// Carries the three small owner controls the place page offers — the heart, the
// favourite rank and dropping off the to-try list — alongside ordinary edits.
// They share a route because they share a subject; each is applied only when
// its key is present.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	// What `toTry: false` did to the row — "deleted" or "unlisted". See
	// removeFromToTry: a place with no visits is removed outright, one with a
	// history is only unlisted.
	let toTry: string | undefined;

	try {
		if ('hearted' in body) await setPlaceHearted(id, Boolean(body.hearted));

		if ('favoriteRank' in body) {
			const rank = body.favoriteRank == null ? null : Number(body.favoriteRank);
			if (rank != null && !(Number.isInteger(rank) && rank >= 1 && rank <= 4)) {
				return apiError('favoriteRank must be 1-4, or null to clear it', 400);
			}
			await setFavoriteRank(id, rank);
		}

		if (body.toTry === false) toTry = await removeFromToTry(id);

		if (typeof body.name === 'string' || hasPlaceEdit(body)) {
			if (body.priceBand != null && !isPriceBand(body.priceBand)) {
				return apiError('priceBand must be $, $$, $$$ or $$$$', 400);
			}
			await updatePlace(id, {
				// Absent means "leave the name alone", which is what a body
				// carrying only a location means.
				...(typeof body.name === 'string' ? { name: body.name } : {}),
				...(Array.isArray(body.cuisines) ? { cuisines: body.cuisines.map(String) } : {}),
				...('priceBand' in body ? { priceBand: (body.priceBand as PriceBand | null) ?? null } : {}),
				...('neighborhood' in body ? { neighborhood: text(body.neighborhood) } : {}),
				...('city' in body ? { city: text(body.city) ?? undefined } : {}),
				...('stateRegion' in body ? { stateRegion: text(body.stateRegion) } : {}),
				...('country' in body ? { country: text(body.country) ?? undefined } : {}),
				...('lat' in body ? { lat: num(body.lat) } : {}),
				...('lng' in body ? { lng: num(body.lng) } : {}),
				...('googlePlaceId' in body ? { googlePlaceId: text(body.googlePlaceId) } : {}),
				...('websiteUrl' in body ? { websiteUrl: text(body.websiteUrl) } : {}),
				...('yelpUrl' in body ? { yelpUrl: text(body.yelpUrl) } : {}),
				...('beliUrl' in body ? { beliUrl: text(body.beliUrl) } : {}),
				...('toTryReason' in body ? { toTryReason: text(body.toTryReason) } : {}),
			});
		}

		return json({ ok: true, ...(toTry ? { toTry } : {}) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to update the place', 500);
	}
};

/** True when the body carries at least one ordinary editable field. */
function hasPlaceEdit(body: Record<string, unknown>): boolean {
	const keys = [
		'cuisines',
		'priceBand',
		'neighborhood',
		'city',
		'stateRegion',
		'country',
		'lat',
		'lng',
		'googlePlaceId',
		'websiteUrl',
		'yelpUrl',
		'beliUrl',
		'toTryReason',
	];
	return keys.some((k) => k in body);
}

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
