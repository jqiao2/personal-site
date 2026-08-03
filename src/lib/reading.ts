// Ingest side of the reading tracker: validate a KOReader sync payload, hand it
// to the database, report what landed.
//
// The endpoint (src/pages/api/reading/sync.ts) stays thin; everything that has
// an opinion lives here, and everything that needs a transaction lives in the
// `ingest_reading_sync` SQL function (migration 0020). This module is the seam
// between the two: it turns loose JSON from a Kindle into rows that cannot
// violate a check constraint, so a bad field is a 400 with a path rather than a
// 500 from Postgres.
//
// Read-side helpers live in src/lib/reading-queries.ts.
import { supabaseAdmin } from './supabase';

/** Caps from the API contract. The plugin chunks; these bound one chunk. */
export const MAX_BOOKS = 500;
export const MAX_SESSIONS = 5000;

/**
 * How far ahead of now a start_time may be before we call it broken. A Kindle
 * that has lost its clock reports wild timestamps, and a single row from 2087
 * stretches the heatmap's date spine by sixty years.
 */
const MAX_FUTURE_SECONDS = 24 * 60 * 60;

export interface SyncBook {
	md5: string;
	title: string;
	authors: string | null;
	series: string | null;
	language: string | null;
	total_pages: number | null;
}

export interface SyncSession {
	book_md5: string;
	page: number;
	/** ISO 8601. Postgres casts it to timestamptz inside the SQL function. */
	started_at: string;
	duration: number;
	total_pages: number | null;
	device: string;
}

export interface SyncPayload {
	device: string;
	books: SyncBook[];
	sessions: SyncSession[];
}

export interface SyncResult {
	books_upserted: number;
	sessions_received: number;
	sessions_inserted: number;
	latest_session_at: string | null;
}

/** A rejected payload, carrying the status the route should return. */
export class SyncPayloadError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = 'SyncPayloadError';
		this.status = status;
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Trimmed non-empty string, or null. */
function text(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

/**
 * A positive integer, or null. Used for the optional page counts, where a 0 or a
 * negative is meaningless rather than wrong: KOReader reports total_pages = 0
 * for a book it hasn't finished laying out yet. Storing null keeps the
 * `total_pages > 0` check happy and lets a later sync fill it in.
 */
function positiveIntOrNull(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Validate and normalise a request body.
 *
 * Throws SyncPayloadError with the failing field's path — the plugin runs
 * headless on a Kindle, so "sessions[37].start_time is required" in a response
 * body is the only debugging surface there is.
 */
export function parseSyncPayload(body: unknown): SyncPayload {
	if (!isObject(body)) throw new SyncPayloadError('expected a JSON object body');

	const device = text(body.device) ?? 'unknown';
	const rawBooks = body.books ?? [];
	const rawSessions = body.sessions ?? [];
	if (!Array.isArray(rawBooks)) throw new SyncPayloadError('books must be an array');
	if (!Array.isArray(rawSessions)) throw new SyncPayloadError('sessions must be an array');

	if (rawBooks.length > MAX_BOOKS) {
		throw new SyncPayloadError(`books exceeds the ${MAX_BOOKS}-item cap`, 413);
	}
	if (rawSessions.length > MAX_SESSIONS) {
		throw new SyncPayloadError(`sessions exceeds the ${MAX_SESSIONS}-item cap`, 413);
	}

	const books = rawBooks.map((raw, i) => parseBook(raw, `books[${i}]`));
	const sessions = rawSessions.map((raw, i) => parseSession(raw, `sessions[${i}]`, device));
	return { device, books, sessions };
}

function parseBook(raw: unknown, path: string): SyncBook {
	if (!isObject(raw)) throw new SyncPayloadError(`${path} must be an object`);

	const md5 = normaliseMd5(raw.md5, `${path}.md5`);
	const title = text(raw.title);
	if (!title) throw new SyncPayloadError(`${path}.title is required`);

	return {
		md5,
		title,
		authors: text(raw.authors),
		series: text(raw.series),
		language: text(raw.language),
		total_pages: positiveIntOrNull(raw.total_pages),
	};
}

function parseSession(raw: unknown, path: string, fallbackDevice: string): SyncSession {
	if (!isObject(raw)) throw new SyncPayloadError(`${path} must be an object`);

	const bookMd5 = normaliseMd5(raw.book_md5, `${path}.book_md5`);

	const page = Number(raw.page);
	if (!Number.isInteger(page) || page <= 0) {
		throw new SyncPayloadError(`${path}.page must be a positive integer`);
	}

	// KOReader's start_time is unix SECONDS. Reading it as milliseconds puts the
	// whole library in 1970, which is the single easiest thing to get wrong here.
	const startTime = Number(raw.start_time);
	if (!Number.isFinite(startTime) || !Number.isInteger(startTime) || startTime <= 0) {
		throw new SyncPayloadError(`${path}.start_time must be a positive unix timestamp in seconds`);
	}
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (startTime > nowSeconds + MAX_FUTURE_SECONDS) {
		throw new SyncPayloadError(`${path}.start_time is more than 24h in the future`);
	}

	const duration = Number(raw.duration);
	if (!Number.isInteger(duration) || duration < 0) {
		throw new SyncPayloadError(`${path}.duration must be a non-negative integer`);
	}

	return {
		book_md5: bookMd5,
		page,
		started_at: new Date(startTime * 1000).toISOString(),
		duration,
		total_pages: positiveIntOrNull(raw.total_pages),
		device: text(raw.device) ?? fallbackDevice,
	};
}

/**
 * md5 is the join key between two devices that have never met, so it is
 * case-folded: KOReader writes lowercase hex, but a hand-made payload or a
 * future ingest path might not, and `A1B2` and `a1b2` must not become two books.
 */
function normaliseMd5(v: unknown, path: string): string {
	const s = text(v);
	if (!s) throw new SyncPayloadError(`${path} is required`);
	return s.toLowerCase();
}

/**
 * Write a validated batch. Books upsert, sessions insert and the batch log all
 * happen inside one Postgres transaction (see `ingest_reading_sync`).
 *
 * sessions_inserted < sessions_received is the normal, healthy case: it's the
 * unique(book_id, page, started_at) constraint discarding rows the plugin has
 * already sent. Sessions naming a book that resolves to nothing are dropped,
 * not fatal.
 */
export async function ingestSync(payload: SyncPayload): Promise<SyncResult> {
	const { data, error } = await supabaseAdmin.rpc('ingest_reading_sync', {
		p_device: payload.device,
		p_books: payload.books,
		p_sessions: payload.sessions,
	});
	if (error) throw new Error(`reading sync failed: ${error.message}`);

	// `returns table` comes back as a one-row array.
	const row = (Array.isArray(data) ? data[0] : data) as SyncResult | undefined;
	if (!row) throw new Error('reading sync returned no result');
	return {
		books_upserted: Number(row.books_upserted ?? 0),
		sessions_received: Number(row.sessions_received ?? 0),
		sessions_inserted: Number(row.sessions_inserted ?? 0),
		latest_session_at: row.latest_session_at ?? null,
	};
}

export interface SyncCursor {
	device: string;
	latest_session_at: string | null;
	session_count: number;
}

/**
 * Resume cursor for a device: the newest session we hold for it, so the plugin
 * can send only what came after and skip re-uploading its whole history.
 */
export async function getSyncCursor(device: string): Promise<SyncCursor> {
	const { data, error, count } = await supabaseAdmin
		.from('reading_sessions')
		.select('started_at', { count: 'exact' })
		.eq('device', device)
		.order('started_at', { ascending: false })
		.limit(1);
	if (error) throw new Error(`sync cursor lookup failed: ${error.message}`);

	return {
		device,
		latest_session_at: data?.[0]?.started_at ?? null,
		session_count: count ?? 0,
	};
}
