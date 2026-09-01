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

