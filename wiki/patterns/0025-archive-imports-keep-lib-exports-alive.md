# The archive still imports from `src/lib` — a "dead" export may not be

**Type:** failure-mode
**Applies when:** removing or renaming an export in `src/lib/` because nothing
outside `src/pages/archive/` seems to use it any more.

## What happened

Paginating `/films/watchlist` replaced its only live caller of
`listAllWatchlist()`. A grep that (correctly) skipped the archive found no other
callers, so the function was deleted. `astro build` then failed:

```
[MISSING_EXPORT] "listAllWatchlist" is not exported by "src/lib/films.ts".
  ╭─[ src/pages/archive/film-wheel.astro:3:10 ]
```

The archive is frozen and off limits (CLAUDE.md), but it is still *built* — its
pages are routes, and their imports resolve against today's `src/lib`. So the
archive is a silent consumer of lib exports that you are not allowed to look at.

## What to do

- Before deleting a lib export, run `npx astro build` (bundling fails fast on a
  missing export, before prerender), or check `git grep -l <name>` for a hit
  under `src/pages/archive/` — a filename-only listing, not a read.
- If the archive uses it, keep the export and say so in its doc comment ("stays
  for the archived …"). Never edit the archive to drop the import.
- The build prerender may then die on unrelated missing env (`R2_ACCOUNT_ID`) in a
  worktree; that's after bundling, so a clean bundle is still the signal you need.
