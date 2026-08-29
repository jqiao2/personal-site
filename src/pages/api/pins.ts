import type { APIRoute } from 'astro';
import { pin, unpin, PinsFullError, PIN_TRACKS, type PinTrack } from '../../lib/pins';
import { requireOwner } from '../../lib/auth';
import { json, apiError } from '../../lib/http';

export const prerender = false;

// POST   /api/pins { track, refId }        → (owner) pin an entry. 409 with the
//                                            current pins when the cap is hit.
// DELETE /api/pins?track=film&refId=123    → (owner) unpin. Idempotent.

function isTrack(v: unknown): v is PinTrack {
	return typeof v === 'string' && (PIN_TRACKS as readonly string[]).includes(v);
}

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: { track?: unknown; refId?: unknown };
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}
	if (!isTrack(body.track)) return apiError('track must be one of film, book, meal, move', 400);
	const refId = Number(body.refId);
	if (!Number.isInteger(refId) || refId <= 0) return apiError('refId is required', 400);

	try {
		await pin(body.track, refId);
		return json({ ok: true }, 201);
	} catch (e) {
		if (e instanceof PinsFullError) {
			const pins = e.pins.map((p) => ({
				track: p.track,
				refId: Number(p.key.split(':')[0]),
				title: p.title,
				href: p.href,
				day: p.day,
				image: p.image,
			}));
			return json({ error: 'pin limit reached', pins }, 409);
		}
		return apiError(e instanceof Error ? e.message : 'failed to pin', 500);
	}
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const track = url.searchParams.get('track');
	if (!isTrack(track)) return apiError('track must be one of film, book, meal, move', 400);
	const refId = Number.parseInt(url.searchParams.get('refId') ?? '', 10);
	if (!Number.isInteger(refId) || refId <= 0) return apiError('refId is required', 400);

	try {
		await unpin(track, refId);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to unpin', 500);
	}
};
