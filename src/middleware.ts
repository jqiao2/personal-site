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
//   - The cookie → `private, no-store`. The owner's copy carries the composer,
//                  private books, unredacted activities; it must never enter a
//                  shared cache, and the owner must never be handed a stale one.
//
// `Vary: Cookie` is only a sane cache key because `film_session` is the sole
// cookie this site sets (see src/lib/auth.ts) — no analytics, no consent banner.
// A second cookie with a per-visitor value would shatter the visitor cache into
// one entry per person and quietly undo all of this.
//
// WHAT THIS COSTS. A visitor can see a page up to FRESH old, and up to
// FRESH + STALE old on a route quiet enough that nobody triggered the background
// refresh. The owner never does: they hold the cookie, so they're always on the
// live render. Staleness is therefore only ever visible to someone who is not in
// a position to notice.
import { defineMiddleware } from 'astro:middleware';
import { requireOwner } from './lib/auth';

/** How long the CDN may serve a visitor's copy without re-rendering. An hour:
 *  long enough that a crawler's sweep costs one render per route, short enough
 *  that a link shared today is right by the time anyone follows it. */
const FRESH = 3600;
/** How long past that it may keep serving the old copy while it refreshes in
 *  the background — so a slow week doesn't turn every visit into a cold render. */
const STALE = 86_400;

export const onRequest = defineMiddleware(async (ctx, next) => {
	const res = await next();

	// Only a plain, successful read is cacheable at all, and a route that already
	// stated its own policy (the TMDB proxies, the no-store activity reads) knows
	// its data better than a blanket rule does — leave those alone.
	if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') return res;
	if (res.status !== 200) return res;
	if (res.headers.has('cache-control')) return res;
	// Vercel refuses to cache a response that sets a cookie anyway; saying so
	// here keeps the header honest rather than misleading.
	if (res.headers.has('set-cookie')) return res;

	// The same predicate the page itself rendered against, not merely "is a cookie
	// present" — an expired or forged cookie produced the visitor's page, so it
	// should get the visitor's caching. It also keeps the dev server honest, where
	// `requireOwner` is true without a cookie and the page really is the owner's.
	if (await requireOwner(ctx.cookies)) {
		res.headers.set('cache-control', 'private, no-store');
		return res;
	}

	// `max-age=0` keeps the browser out of it: it revalidates on every visit, but
	// against the CDN, which is free. Only `s-maxage` holds the copy.
	res.headers.set('cache-control', `public, max-age=0, s-maxage=${FRESH}, stale-while-revalidate=${STALE}`);
	// Append: Astro already varies some responses on Origin, and replacing that
	// outright would let one origin's copy answer another's.
	res.headers.append('vary', 'Cookie');
	return res;
});
