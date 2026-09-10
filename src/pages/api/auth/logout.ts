import type { APIRoute } from 'astro';
import { COOKIE_NAME, OWNER_HINT_COOKIE } from '../../../lib/auth';
import { json } from '../../../lib/http';

export const prerender = false;

// POST /api/auth/logout  → clears the session cookie and its readable companion.
export const POST: APIRoute = async ({ cookies }) => {
	cookies.delete(COOKIE_NAME, { path: '/' });
	cookies.delete(OWNER_HINT_COOKIE, { path: '/' });
	return json({ ok: true });
};
