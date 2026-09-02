# Evolution log

Append-only. One line per consolidation: what changed in the wiki/skills and why.
Never edit or delete past entries — this is the audit trail (WikiSkill keeps the
wiki across every iteration, even reverted ones).

- 2026-08-29 — Bootstrapped the WikiSkill knowledge base (README, index, logs) and
  seeded pattern 0001 (Supabase CLI in worktrees). Wired the read/consolidate loop
  into CLAUDE.md / AGENTS.md.
- 2026-08-31 — Two rounds of month-in-review layout fixes went out verified only
  by numbers, and the rendered page still had cell boxes painting over the previous
  day's prints. Added `npm run shot` (Playwright devDependency + scripts/shot.mjs) so
  any agent can look at a page, and wrote pattern 0002.

- 2026-09-01 — Added pattern 0003 (`create or replace view` cannot change a column
  list) while moving price out of the diary view. Root-causes the same trap 0031
  hit from the other direction.
- 2026-09-01 — Extracted the watchlist add-composer into a shared
  `WatchlistComposer.astro` (reused on `/films` header + watchlist page). Truncating
  watchlist.astro with a PowerShell `Get-Content|Set-Content` round-trip mojibake'd
  every non-ASCII glyph in the file; recovered with `git checkout` + Edit-tool re-apply.
  Wrote pattern 0004.
- 2026-09-01 — Restaurant composer opened on the wrong day: `localDay()` was called
  in Astro frontmatter (server, UTC) and a repeat visit inherited the last visit's
  date. Moved the default into the client script and stopped carrying `visitedOn`.
  Pattern 0005 (renumbered from 0003, which main had taken twice).
- 2026-09-01 — Lift/run detection for ski days. `src/lib/ski.ts` segments the
  altitude sawtooth (hysteresis over smoothed altitude); exertion gained a rung
  4.5 (`ski`) that scores only active-descent time, so a resort day no longer
  reads ~5 off the broken Slopes `moving_seconds` — big days now score ~90–130.
  A Slopes-style "Runs & lifts" breakdown (`SkiRuns.astro`) replaces the useless
  Strava auto-laps. Migration 0050 widened the exertion_method constraint. Wrote
  pattern 0006. `db push` to this project needs the `aws-1-us-west-2` pooler host
  (not `aws-0`), which returns "tenant not found".
- 2026-09-02 — Made ski runs/lifts editable and drew them on the profile.
  `activities.ski_segments` (0051) stores a hand-corrected partition that
  `resolveSkiSegments` uses in place of detection everywhere (display, profile,
  exertion); the editor is reclassify-only, with merge falling out of coalescing.
  Profile gained coloured run/lift bands (ActivityGraph). Extended pattern 0006
  with the override + testing notes (saveSkiSegments needs Astro's import.meta.env,
  and a form POST to astro dev needs a matching Origin header or it 403s).

- 2026-09-02 — Audited /films and /books for the unified header. Eight rendered
  pages had none (the film section had it only on its index). Added it, matching
  the restaurant log's strip-over-topbar arrangement. Two things were worth
  keeping: the audit has to read `src/layouts` too (restaurants inherit the
  header from their layout and never name it), and the 100vw bleed lets the
  strip sit inside a narrower centred `.wrap` without touching that page's CSS —
  but the nav only lines up if `--sh-max` is the column plus twice the header
  gutter, which is what the new `max` prop is for. Wrote pattern 0007.
