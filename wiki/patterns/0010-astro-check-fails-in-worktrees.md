# Dev server / `astro check` fail in a worktree when the MAIN repo has no `node_modules`

**Type:** failure-mode
**Applies when:** the dev server or `astro sync`/`astro check` dies in a
`.claude/worktrees/*` checkout with a tsconfig-resolution error, on a machine
where the main clone was never `npm install`ed (e.g. a fresh macOS box for a
repo normally developed on Windows).

## Symptom

```
[GenerateContentTypesError] `astro sync` … failed to generate content
collection types: Tsconfig not found astro/tsconfigs/strict.
```

The dev server exits during startup (code 1). It looks like the *worktree's*
`tsconfig.json` (which extends `astro/tsconfigs/strict`) is unresolvable — but
editing or even emptying the worktree tsconfig does **not** change the error.

## Root cause

A worktree lives **inside** the main repo at `.claude/worktrees/<name>/`. Vite 8
uses a native (rolldown/oxc) tsconfig resolver that walks **up** the directory
tree, escapes the worktree, and reaches the **main repo's** `tsconfig.json` at
the repo root. That file also extends `astro/tsconfigs/strict`, and it's
resolved relative to the **main repo**, which has no `node_modules/astro`
(worktrees don't share the main clone's install, and on this machine main was
never installed). Package resolution of `astro/tsconfigs/strict` fails there →
the whole content-types generation aborts → dev won't boot.

Proof it's the parent, not the worktree: set the *worktree* tsconfig extends to
a resolvable relative path (`./node_modules/astro/tsconfigs/base.json`) and the
error **still** says `astro/tsconfigs/strict` — a string that now only exists in
the main repo's tsconfig.

`astro/tsconfigs/strict` resolves fine from any dir that has `node_modules/astro`
beside it, so the worktree's own copy is never the problem.

## Fix

Install the main repo's dependencies so its tsconfig resolves — no `cd` needed:

```
npm install --prefix /path/to/main/repo --no-audit --no-fund
```

That's the whole fix; the worktree dev server then boots. This is also why it
"just works" on the normal dev machine — there the main clone is installed.

Don't bother editing the worktree tsconfig, clearing `.astro`/`node_modules/.vite`,
or switching the extends form (`strict` vs `strict.json` vs relative) — none of
it matters while the parent tsconfig is unresolvable.

## Also in this situation

- A worktree has no `.env` (untracked, not inherited). Put the real `.env` in the
  **main repo root** so every worktree can `cp ../../../.env .env` — or copy it in.
- No real `.env` anywhere means only a placeholder gets the config to load;
  data pages then fail with `fetch failed` against the fake Supabase. Delete a
  placeholder `.env` when done (ACTIVITIES.md flags it as a footgun for the
  importer/backfill scripts).
