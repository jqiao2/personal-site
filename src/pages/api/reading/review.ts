import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import {
	deleteReview,
	FOCUS,
	getBook,
	MOODS,
	PACING,
	saveReview,
	TONES,
} from '../../../lib/book-queries';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// POST   /api/reading/review  { bookId, readFrom, readTo, … }  → (owner) save.
// DELETE /api/reading/review?bookId=1&id=7                     → (owner) delete.
//
// A review belongs to a READ, not to a book: the (readFrom, readTo) pair is the
// stretch of sessions it is about, and it is also the upsert key. Re-reading a
// book therefore adds a review rather than overwriting one, and saving the same
// read twice edits it — which is what the dialog's Re-read toggle is choosing
// between when it swaps one date range for another.

/** Half stars only, 0.5–5. Null is "not rated", which is a real answer. */
function parseRating(v: unknown): number | null {
	if (v == null || v === 0 || v === '') return null;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0.5 || n > 5) return null;
	const halved = Math.round(n * 2) / 2;
	return halved >= 0.5 ? halved : null;
}

function parseDay(v: unknown): string | null {
	return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * Keep only values from the vocabulary, in the vocabulary's own order.
 *
 * Uncapped by design — the design asks for no selection limit — but not
 * unbounded: a payload can only ever contain each term once, so the largest
 * possible review is ten moods and thirteen tones.
 */
function parseList(v: unknown, vocabulary: readonly string[]): string[] {
	if (!Array.isArray(v)) return [];
	const chosen = new Set(v.filter((x): x is string => typeof x === 'string'));
	return vocabulary.filter((term) => chosen.has(term));
}

function parseOption(v: unknown, vocabulary: readonly string[]): string | null {
	return typeof v === 'string' && (vocabulary as readonly string[]).includes(v) ? v : null;
}

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const bookId = Number(body.bookId);
	if (!Number.isInteger(bookId) || bookId <= 0) return apiError('bookId is required', 400);

	const readFrom = parseDay(body.readFrom);
	const readTo = parseDay(body.readTo);
	if (!readFrom || !readTo) return apiError('readFrom and readTo must be YYYY-MM-DD', 400);
	if (readTo < readFrom) return apiError('readTo must not precede readFrom', 400);

	const book = await getBook(bookId, true);
	if (!book) return apiError('book not found', 404);

	const text = typeof body.text === 'string' ? body.text.trim() : '';

	try {
		await saveReview(bookId, {
			read_from: readFrom,
			read_to: readTo,
			rating: parseRating(body.rating),
			loved: body.loved === true,
			gave_up: body.gaveUp === true,
			review_text: text || null,
			pacing: parseOption(body.pacing, PACING),
			focus: parseOption(body.focus, FOCUS),
			moods: parseList(body.moods, MOODS),
			tones: parseList(body.tones, TONES),
		});
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'review save failed', 500);
	}

	return json({ ok: true });
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const bookId = Number.parseInt(url.searchParams.get('bookId') ?? '', 10);
	const id = Number.parseInt(url.searchParams.get('id') ?? '', 10);
	if (!Number.isInteger(bookId) || !Number.isInteger(id)) {
		return apiError('bookId and id are required', 400);
	}

	try {
		const removed = await deleteReview(bookId, id);
		if (!removed) return apiError('review not found', 404);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'review delete failed', 500);
	}

	return json({ ok: true });
};
