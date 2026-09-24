// Let Vercel's CDN answer for visitors, so a function only runs for the owner.
//
// Almost every route here is `prerender = false`, and for one reason: the header
// has to know whether you're signed in, and a prerendered page bakes that answer
// in at build time. The cost of that decision is that EVERY request — a reader,
// a feed poller, a crawler walking all ~100 routes — wakes a serverless function
// that opens a Supabase connection and renders the page from scratch. Nothing
// was cached, so nothing was ever reused, and that is what ran the account out
// of its Fluid Active CPU allowance.
//
// The saving grace is that "signed in" is one bit, carried by one cookie, held
// by one person. So the response to a request WITHOUT that cookie is the same
// for everybody, forever — exactly the thing a CDN is for:
//
//   - No cookie  → `s-maxage`, plus `Vary: Cookie` so the cached copy is only
//                  ever handed to another cookie-less request. Repeat visits
//                  inside the window are served by the CDN with no function run
//                  and no CPU billed.
//   - The cookie → `private, max-age=OWNER_FRESH`. The owner's copy carries the
//                  composer, private books, unredacted activities, so it must
//                  never enter a shared cache. It may sit in the owner's own
//                  browser for a minute, which makes back/forward and a quick
//                  return to a page free. See "the owner's staleness" below.
//
// `Vary: Cookie` is only a sane cache key because every cookie this site sets
// is owner-only (see src/lib/auth.ts): a visitor carries none. No analytics, no
// consent banner. A cookie with a per-visitor value would shatter the visitor
// cache into one entry per person and quietly undo all of this.
//
// WHAT THIS COSTS. A visitor can see a page up to FRESH old, and up to
// FRESH + STALE old on a route quiet enough that nobody triggered the background
// refresh. For a life log read by strangers, a day is invisible.
//
// The owner's staleness is bounded differently, because the owner is the one
// person who would notice. Their copies also vary on Cookie, and every
// successful owner write under /api/ re-stamps WRITE_STAMP_COOKIE. After a save,
// every page the browser holds is a miss, whether the editor reloads or
// navigates with `location.href`. What the stamp cannot see is a write that
// doesn't come from the owner's browser (the Strava cron, the Kindle sync, the
// calendar sync), and OWNER_FRESH is what bounds that.
import { defineMiddleware } from 'astro:middleware';
import { MAX_AGE_SECONDS, requireOwner, WRITE_STAMP_COOKIE } from './lib/auth';

/** How long the CDN may serve a visitor's copy without re-rendering. A day: the
 *  site has ~5,000 unique detail URLs (every movie, place and activity), so a
 *  crawler that slips the bot filter costs one render per URL per window. Every
 *  one is a function run billed as Active CPU (wiki 0018) and a Supabase pull
 *  billed as egress, so the wider the window, the fewer of them. The owner
 *  doesn't see this copy, so the staleness only reaches visitors. Shorten it if
 *  a shared link needs to be fresher than that. */
const FRESH = 86_400;

/** How long past that it may keep serving the old copy while it refreshes in
 *  the background — so a slow week doesn't turn every visit into a cold render. */
const STALE = 86_400;

/** How long the owner's browser may reuse its own private copy. Kept short
 *  because it is the only bound on writes the write stamp can't see (the
 *  background syncs). Owner writes invalidate it immediately regardless. */
const OWNER_FRESH = 60;

export const onRequest = defineMiddleware(async (ctx, next) => {
	const res = await next();

	if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') {
		// Re-stamp after an owner write so the owner's browser-cached pages miss.
		// /api/auth/ is excluded: login isn't an owner request yet, and logout
		// clears the stamp itself. `res.ok` also skips redirects, whose headers
		// are immutable.
		if (res.ok && ctx.url.pathname.startsWith('/api/') && !ctx.url.pathname.startsWith('/api/auth/') && (await requireOwner(ctx.cookies))) {
			res.headers.append(
				'set-cookie',
				`${WRITE_STAMP_COOKIE}=${Date.now().toString(36)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${import.meta.env.PROD ? '; Secure' : ''}`,
			);
		}

		return res;
	}

	// Only a plain, successful read is cacheable at all, and a route that already
	// stated its own policy (the TMDB proxies, the no-store activity reads) knows
	// its data better than a blanket rule does — leave those alone.
	if (res.status !== 200) return res;

	if (res.headers.has('cache-control')) return res;

	// Vercel refuses to cache a response that sets a cookie anyway; saying so
	// here keeps the header honest rather than misleading.
	if (res.headers.has('set-cookie')) return res;

	// Both copies vary on Cookie: the visitor's so the CDN never hands it to the
	// owner, the owner's so a login, logout or write stamp misses the browser's
	// copy. Append: Astro already varies some responses on Origin, and replacing
	// that outright would let one origin's copy answer another's.
	res.headers.append('vary', 'Cookie');

	// The same predicate the page itself rendered against, not merely "is a cookie
	// present" — an expired or forged cookie produced the visitor's page, so it
	// should get the visitor's caching. It also keeps the dev server honest, where
	// `requireOwner` is true without a cookie and the page really is the owner's.
	if (await requireOwner(ctx.cookies)) {
		res.headers.set('cache-control', `private, max-age=${OWNER_FRESH}`);

		return res;
	}

	// `max-age=0` keeps the browser out of it: it revalidates on every visit, but
	// against the CDN, which is free. Only `s-maxage` holds the copy.
	res.headers.set('cache-control', `public, max-age=0, s-maxage=${FRESH}, stale-while-revalidate=${STALE}`);

	return res;
});
