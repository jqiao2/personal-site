import type { APIRoute } from 'astro';
import {
	checkPassword,
	createSessionToken,
	COOKIE_NAME,
	OWNER_HINT_COOKIE,
	sessionCookieOptions,
	ownerHintCookieOptions,
} from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// POST /api/auth/login  { password }
// On success, sets the signed httpOnly session cookie. Phone-friendly: log in
// once and the cookie sticks for 30 days.
export const POST: APIRoute = async ({ request, cookies }) => {
	let body: { password?: string };
	try {
		body = await request.json();
	} catch {
		return apiError('expected JSON body', 400);
	}

	if (!checkPassword(body.password ?? '')) return apiError('invalid password', 401);

	cookies.set(COOKIE_NAME, await createSessionToken(), sessionCookieOptions());
	// The readable companion, set in lockstep so the header can hide the "Log in"
	// button client-side on statically-served pages. Carries no authority.
	cookies.set(OWNER_HINT_COOKIE, '1', ownerHintCookieOptions());
	return json({ ok: true });
};
