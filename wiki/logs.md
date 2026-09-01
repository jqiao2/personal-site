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
- 2026-09-01 — Restaurant composer opened on the wrong day: `localDay()` was called
  in Astro frontmatter (server, UTC) and a repeat visit inherited the last visit's
  date. Moved the default into the client script and stopped carrying `visitedOn`.
  Pattern 0004 (renumbered from 0003, which main had taken).
