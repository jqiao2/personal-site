# Evolution log

Append-only. One line per consolidation: what changed in the wiki/skills and why.
Never edit or delete past entries — this is the audit trail (WikiSkill keeps the
wiki across every iteration, even reverted ones).

- 2026-08-29 — Bootstrapped the WikiSkill knowledge base (README, index, logs) and
  seeded pattern 0001 (Supabase CLI in worktrees). Wired the read/consolidate loop
  into CLAUDE.md / AGENTS.md.

- 2026-09-01 — Restaurant composer opened on the wrong day: `localDay()` was called
  in Astro frontmatter (server, UTC) and a repeat visit inherited the last visit's
  date. Moved the default into the client script and stopped carrying `visitedOn`.
  Pattern 0002.
