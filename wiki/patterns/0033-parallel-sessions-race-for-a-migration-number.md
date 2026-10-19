# 0033 — Parallel sessions race for the next migration number

**Type:** failure-mode
**Applies when:** writing a migration while other agent sessions/worktrees are open, or `db push` says "Remote migration versions not found in local migrations directory" naming one recent version.

## Symptom
`list_migrations` showed 0075 as the latest, so the file went in as 0076. Minutes later `supabase migration list` showed a remote 0076 already applied (`film_ranking`, from a sibling worktree whose PR wasn't merged yet). `db push` then refuses: the remote has a version the local tree lacks.

## Root cause
Migration numbers are claimed by whoever applies first, not by whoever is on `main`. Another session can take N between your history check and your push, and its file lives only in its own unmerged worktree.

## Fix
- Re-check `supabase migration list --workdir .` immediately before pushing, and renumber yours to the next free version.
- To get `db push` past the sibling's version without touching history: copy its file from `../<other-worktree>/supabase/migrations/` into yours for the push only (it is already applied, so it isn't re-run), confirm with `--dry-run` that only your file is pending, push, then delete the copy. Do not commit it, and never `migration repair --status reverted` it.
- Whichever PR merges second carries the higher number; if theirs merges after yours, nothing breaks, since versions only need to be unique.

## Seen
- 2026-10-19 — film lists (0077) vs film ranking (0076).
