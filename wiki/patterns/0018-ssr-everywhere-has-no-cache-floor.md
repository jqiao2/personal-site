# An all-SSR site has no floor under its compute bill

**Type:** failure-mode
**Applies when:** a Vercel/serverless bill (Fluid Active CPU, invocations) runs
over on a low-traffic site, or a route is made `prerender = false` for a reason
unrelated to its data. The **egress** half below applies when a Supabase (or any
DB) egress allowance is blown, or before adding a `select('*')` on a view.

## What happened

The Vercel free tier's 4 hours of Fluid Active CPU ran out. The suspicion was the
newest and heaviest feature, `/projects/film-credit-network`, which rebuilds a
collaboration graph from the whole watch log on every request.

Measured, that route *is* the most expensive on the site — and by a distance:

| route | CPU | wall | HTML |
|---|---|---|---|
| `/projects/film-credit-network` | ~109 ms | ~4.9 s | 702 KB |
| `/films/diary` | ~31 ms | 0.7 s | 157 KB |
| `/films`, `/month`, `/restaurants/places` | ~16 ms | 0.2–0.6 s | 74–243 KB |
| everything else, and every server island | ~0 ms | 0.05–0.9 s | 20–115 KB |

But that does not add up to four hours. At 109 ms you would need ~130,000 views
of one page. The wall/CPU gap is the tell: these routes are almost entirely
waiting on Supabase, and idle I/O is not billed as Active CPU.

## The root cause

The bill was never about any one route. It was that **~100 routes were
`prerender = false` and not one of them sent a `Cache-Control` header**, so every
request — a reader, a feed poller, a crawler walking the whole site — woke a
function and paid the ~77 ms cold-start import before rendering anything. There
was no cache anywhere and no `robots.txt`, so nothing was ever reused and nothing
was ever discouraged. Volume, not any single render, was the cost.

Worth noting *why* those routes were SSR: not because their data is per-request,
but because `SiteHeader` calls `requireOwner()` and a prerendered page would bake
"logged out" in at build time. The whole compute bill traced back to one button.

## The fix

`src/middleware.ts`. Owner-ness is one bit, carried by one cookie, held by one
person — so the response to a request *without* that cookie is identical for
everybody and belongs in a CDN:

- no cookie → `public, max-age=0, s-maxage=3600, stale-while-revalidate=86400`
  plus `Vary: Cookie`
- the cookie → `private, no-store`

Skip anything that is not a 200 GET/HEAD, already carries its own
`Cache-Control`, or sets a cookie.

## What to check before copying this

- **`Vary: Cookie` is only a sane cache key if you set exactly one cookie.** Add
  analytics or a consent banner and the visitor cache shatters into one entry per
  person, silently undoing all of it. Vercel does honour arbitrary `Vary`.
- **Branch on the same predicate the page rendered against** (`requireOwner`),
  not on `cookies.has(...)`. An expired cookie produced the visitor's page and
  should get the visitor's caching, and it keeps the dev server — where
  `requireOwner` is true with no cookie — honest.
- **`append` to `Vary`, don't `set`.** Astro varies some responses on `Origin`.
- Vercel will not cache a response carrying `set-cookie`, and treats `Vary: *` as
  `private`.

## Measuring this yourself

Wall-clock timing will point at the wrong thing, because it is mostly database
latency that Vercel does not bill. Sample the server process's CPU instead:

```powershell
$p = Get-Process -Id <dev server pid>; $c0 = $p.TotalProcessorTime
Invoke-WebRequest "http://localhost:4400$route" -UseBasicParsing | Out-Null
$p.Refresh(); ($p.TotalProcessorTime - $c0).TotalMilliseconds
```

Take a median of three after a warm-up hit; Windows' 15.6 ms tick means anything
under ~16 ms reads as 0, which is itself a useful answer.

Two traps in this repo: `astro dev status` gives you the pid, and server islands
(`/_server-islands/...`) are *separate invocations* — timing the page alone
misses them, so pull the island URL out of the HTML and time it too.

## Resolved since

The deeper fix **was** taken (#226): `SiteHeader` renders "Log in" for everyone
and an `is:inline` script hides it from a non-httpOnly `owner=1` cookie before
first paint. `film_session` (signed, httpOnly) stays the only thing the server
trusts; `owner=1` grants nothing. Nine header-only-differing pages became static
CDN files, so most of the site now costs nothing at all — the button that drove
the whole bill no longer forces SSR.

Still not confirmable here: Vercel's own per-route usage, which would have shown
the CPU split, needs a dashboard/CLI login this environment does not have. Moot
now that the routes it would have measured are static; the structural fix holds
regardless of how the traffic was distributed.

## The other half of the same bill: DB egress

The same incident also blew Supabase's 5 GB egress allowance, and it is worth
measuring separately — CPU and egress fail independently, and the cache above
does nothing for a render that was already cheap in CPU but fat on the wire.

The tool is the same throwaway `fetch` shim, but counting **response** bytes from
the Supabase host per request instead of CPU. Wrap `globalThis.fetch`, clone any
response whose URL contains the Supabase host, and append
`response.arrayBuffer().byteLength` to a log keyed by the PostgREST path. Load it
via `NODE_OPTIONS="--import ./scripts/_shim.mjs"` — but note Astro's dev CLI
re-spawns and loses `NODE_OPTIONS`; start the server in-process instead
(`import { dev } from 'astro'; await dev({ root: process.cwd() })`) so the shim
survives. Server islands are a second request here too.

What it found: every feed/landing render pulled 150 KB–1.7 MB from the DB, and
`/rss.xml` spent 299 KB to emit a 9 KB feed. The cause was one fat column on a
shared view — `activity_list.polyline`, a full-fidelity GPS track, was 72% of the
view's bytes, and the four `select('*')` reads of that view never touched it. It
rode along on every home feed, every `/month`, every RSS poll.

The lesson that generalizes: **`select('*')` on a view is a standing egress leak
the moment anyone adds a heavy column to the view**, because the callers don't
change and nobody re-checks what they now drag. Grep for the column's real
readers before assuming a `*` needs it; here two pages wanted the track and both
read it straight off the base table, so the view never needed to carry it.
Migration 0064 dropped it (drop-and-rebuild, per wiki 0003). Measured saving:
~70% on the affected reads.
