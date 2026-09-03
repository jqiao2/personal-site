// Owner auth for the single-user diary. There's exactly one user (you), so
// instead of a full auth system we use one password and a signed session cookie.
//
// Flow: POST /api/auth/login with the password → we set an httpOnly, signed
// cookie → write endpoints call requireOwner() to check it. The cookie value is
// `<expiry>.<hmac>`, signed with SESSION_SECRET so it can't be forged.
import type { AstroCookies } from 'astro';

export const COOKIE_NAME = 'film_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const encoder = new TextEncoder();

function secret(): string {
	const s = import.meta.env.SESSION_SECRET;
	if (!s) throw new Error('SESSION_SECRET is not set');
	return s;
}

function base64url(bytes: ArrayBuffer): string {
	const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret()),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
	return base64url(sig);
}

/** Length-safe, timing-safe-ish string comparison. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Check a submitted password against ADMIN_PASSWORD. */
export function checkPassword(input: string): boolean {
	const expected = import.meta.env.ADMIN_PASSWORD;
	if (!expected) throw new Error('ADMIN_PASSWORD is not set');
	return typeof input === 'string' && input.length > 0 && safeEqual(input, expected);
}

/**
 * 'unconfigured' is deliberately not merged into 'unauthorized'. The caller is
 * a Kindle with no screen to show an error on, so the difference between "your
 * token is wrong" and "the server has no token to compare against" is the
 * difference between a two-minute fix and an evening of guessing.
 */
export type SyncAuthResult = 'ok' | 'unauthorized' | 'unconfigured';

/**
 * Check an `Authorization: Bearer …` header against READING_SYNC_TOKEN.
 *
 * The reading sync is machine-to-machine — a Kindle running KOReader, with no
 * cookie jar and no login page — so it carries a static bearer token instead of
 * the owner session above. Same constant-time comparison; the length check is
 * what keeps it from throwing on a token of the wrong size.
 *
 * Returns rather than throws on a missing environment variable: a config
 * mistake should surface as a described failure, not a stack trace the runtime
 * turns into an opaque 500.
 */
export function checkSyncToken(
	header: string | null | undefined,
	expected: string | undefined = import.meta.env.READING_SYNC_TOKEN,
): SyncAuthResult {
	if (!expected) return 'unconfigured';
	if (typeof header !== 'string') return 'unauthorized';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return 'unauthorized';
	return safeEqual(match[1], expected) ? 'ok' : 'unauthorized';
}

/** Mint a signed session token that expires MAX_AGE_SECONDS from now. */
export async function createSessionToken(): Promise<string> {
	const exp = Date.now() + MAX_AGE_SECONDS * 1000;
	const sig = await hmac(String(exp));
	return `${exp}.${sig}`;
}

async function isValidToken(token: string | undefined): Promise<boolean> {
	if (!token) return false;
	const dot = token.lastIndexOf('.');
	if (dot < 0) return false;
	const expPart = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const exp = Number.parseInt(expPart, 10);
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const expected = await hmac(expPart);
	return safeEqual(sig, expected);
}

/**
 * Owner without a login, when and only when this is a local dev server.
 *
 * Almost the entire site is owner-gated — the log composer, the watchlist
 * toggles, the whole right-hand half of a book page — so a dev server that
 * treats you as a visitor can only ever exercise the small public part of what
 * is being built. Logging in to check a button is friction on every restart, in
 * every worktree.
 *
 * This cannot reach production, and not by convention: `import.meta.env.DEV` is
 * substituted by Vite at transform time, so in any built bundle this function
 * begins `if (!false) return false` and the rest is dead code the minifier
 * removes. There is no environment variable Vercel could be given that turns it
 * back on, because the branch is not in the deployed file at all.
 *
 * Set `OWNER_DEV=0` in .env to opt out and browse the dev server as a stranger
 * — which is the only way to check what a visitor is not supposed to see.
 */
function isDevOwner(): boolean {
	if (!import.meta.env.DEV) return false;
	const flag = import.meta.env.OWNER_DEV;
	return flag !== '0' && flag !== 'false';
}

/** True if the request carries a valid owner session cookie. */
export function requireOwner(cookies: AstroCookies): Promise<boolean> {
	if (isDevOwner()) return Promise.resolve(true);
	return isValidToken(cookies.get(COOKIE_NAME)?.value);
}

/** Options for the session cookie. Secure in production, httpOnly always. */
export function sessionCookieOptions(): {
	httpOnly: boolean;
	secure: boolean;
	sameSite: 'lax';
	path: string;
	maxAge: number;
} {
	return {
		httpOnly: true,
		secure: import.meta.env.PROD,
		sameSite: 'lax',
		path: '/',
		maxAge: MAX_AGE_SECONDS,
	};
}
