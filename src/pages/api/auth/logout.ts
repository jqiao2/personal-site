import type { APIRoute } from 'astro';
import { COOKIE_NAME } from '../../../lib/auth';
import { json } from '../../../lib/http';

export const prerender = false;

// POST /api/auth/logout  → clears the session cookie.
export const POST: APIRoute = async ({ cookies }) => {
	cookies.delete(COOKIE_NAME, { path: '/' });
	return json({ ok: true });
};
