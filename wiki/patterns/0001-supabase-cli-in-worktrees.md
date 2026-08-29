# 0001 — Supabase CLI in git worktrees

**Type:** failure-mode
**Applies when:** running `supabase db push`, `link`, or `migration` from a
`.claude/worktrees/*` checkout rather than the main clone.

## Symptom
`supabase db push` from a worktree can't find the project config and behaves as if
unlinked, or pushes against the wrong/no project.

## Root cause
The worktree has no `supabase/config.toml` of its own — that state lives in the
main checkout. The CLI resolves config relative to the working dir, so from a
worktree it sees nothing and needs to be pointed at the config explicitly and
re-linked for this checkout.

## Workaround
- Pass `--workdir .` so the CLI treats the worktree root as the project.
- Re-run `supabase link` for this checkout before `db push` (needs CLI ≥ 2.115.0).
- Do **not** `supabase db pull` here — it can rewrite migration history to
  `remote_schema` rows. If history gets wiped, repair with `supabase migration
  repair` rather than pulling.
- Remember the migration-numbering rule in `CLAUDE.md`: numbers are versions,
  never reuse one, and a reused number is silently skipped by `db push`.

## Seen
- 2026-08-29 — Seeded from accumulated project knowledge while setting up this
  wiki. Verify the exact flags against the installed CLI version before relying on
  them.
