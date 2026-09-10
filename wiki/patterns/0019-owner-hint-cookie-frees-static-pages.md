# A readable owner-hint cookie lets owner-aware pages go static

**Type:** strategy
**Applies when:** a page is `prerender = false` only so a server-rendered header
can tell the owner apart from a visitor (the "Log in" button, an edit affordance),
and you want it static to cut function invocations — the follow-through from
wiki 0018.

## The bind

`SiteHeader` rendered the "Log in" button only for visitors (`{!owner && …}`),
and `owner` came from `requireOwner(Astro.cookies)` — a per-request read. So any
page carrying the header had to be SSR, or a prerendered build would bake
`owner=false` and show the owner a "Log in" button they don't need (the exact bug
PR #222 "fixed" by converting the last static pages *to* SSR — the wrong
direction, as it turned out, once the compute bill came in).

The header was the *only* per-request difference on a whole class of otherwise
static pages: /about, /subway, /projects, /projects/[id], the credit-network
shell, /404, the home shell, /archive, /bike-outline.

## The move

"Owner" is one bit, held by one person. Split it from the authority that backs it:

- **`film_session`** (signed, httpOnly) stays the only thing the server trusts.
  Every real gate still calls `requireOwner()` against it.
- **`owner=1`** (NOT httpOnly, set/cleared in lockstep with the session on
  login/logout) is a readable *hint*. It grants nothing — forging it only hides a
  button from yourself.

The header now renders the button (and modal) for everyone, and a tiny
`is:inline` script sets `html[data-owner]` from the cookie; global CSS hides the
button when that attribute is present. Because the markup is now identical for
owner and visitor, the page can be one static file the CDN serves to all — the
owner's difference is applied entirely on the client.

## Why no flash (this matters here)

The site's rule is that nothing moves; a "Log in" button that appears then
vanishes would break it. So the detection is a **synchronous `is:inline` script
placed before the header in the body** — not a hoisted module (deferred, runs
after paint) and not the header's existing `<script>` blocks (also modules). It
sets the attribute before the browser parses the header element, so the button is
never painted visible for the owner. Verified with Playwright: `data-owner=1`
before first paint, button `isVisible()` false; without the cookie, visible.

## What stays SSR

Only the header made these pages owner-different. Pages with owner-only *content*
(the four log sections' edit controls, private data) stay SSR — their visitor
copy is cached and the owner gets a fresh `private, no-store` render (wiki 0018).
Server islands are unaffected: the home shell is now static while `RecentFeed`
(`server:defer`) stays a per-request island that re-checks the owner itself —
static shell + dynamic island is the intended pattern, not a workaround.

## Gotchas

- `document.cookie.split('; ').includes('owner=1')` — exact-match against the
  split parts, so `downer=1` or a substring can't trip it.
- The hint cookie must mirror the session cookie's `path`, `secure`, `sameSite`
  and `maxAge` so the two travel and expire together — only `httpOnly` differs.
- Astro's CSRF origin check 403s a POST with no `Origin` and a non-JSON body, so
  testing `/api/auth/logout` from bare `fetch` needs an `Origin` header; the JSON
  login is exempt. Not a bug in the endpoint.
- `.env` here quotes `ADMIN_PASSWORD` (`"…"`); Astro's `loadEnv` strips the
  quotes, a hand-rolled `.env` parser in a test script must too.

## Payoff

Nine pages moved from a function-per-request to a CDN-served file, including the
site's two most-hit pages (home, and the credit-network shell). This is the
"deeper fix, not taken" noted at the bottom of [[0018-ssr-everywhere-has-no-cache-floor]].
