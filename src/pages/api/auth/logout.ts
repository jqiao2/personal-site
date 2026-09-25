import type { APIRoute } from 'astro';
import { COOKIE_NAME, OWNER_HINT_COOKIE, WRITE_STAMP_COOKIE } from '../../../lib/auth';
import { json } from '../../../lib/http';

export const prerender = false;

// POST /api/auth/logout  → clears the session cookie, its readable companion and
// the write stamp, leaving a logged-out browser cookie-less. The CDN's visitor
// copy is varied on Cookie, so a leftover cookie would keep that browser off it.
export const POST: APIRoute = async ({ cookies }) => {
	cookies.delete(COOKIE_NAME, { path: '/' });
	cookies.delete(OWNER_HINT_COOKIE, { path: '/' });
	cookies.delete(WRITE_STAMP_COOKIE, { path: '/' });

	return json({ ok: true });
};
