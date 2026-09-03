# 0002 — Screenshot the page yourself instead of asking for one

**Type:** strategy
**Applies when:** changing anything whose correctness is visual — layout, spacing,
overlap, a share card, a chart, a map — in this repo.

## The failure this replaces

Layout work was being verified by reasoning about the CSS and then asking the user
to paste a screenshot back. Two rounds of the month-in-review card went out that
way: the geometry was checked numerically and passed, and the rendered page still
had the day's ruled boxes painting over the neighbouring day's photographs, which
one look would have caught. Numbers can only check the property you thought to
measure; a screenshot checks the ones you didn't.

## Do this

```
npm run shot -- month/2026-08                              # tmp/shot.png at 1280x900
npm run shot -- month/2026-08 tmp/card.png --el "[data-card]"   # just the artboard
npm run shot -- films tmp/films.png --width 1400 --full
```

Then open the PNG with the Read tool. `scripts/shot.mjs` starts its own dev server
on port 4380, screenshots with Playwright at 2x, and stops the server again.

## What it needs, and the traps

- **`.env` in the worktree.** `git worktree` doesn't copy untracked files, so a
  fresh worktree has none and every database-backed page 500s. `cp ../../../.env .env`.
  `R2_PUBLIC_URL` isn't in that file and the astro config throws without it — see
  the memory note for the dev bucket hostname.
- **No login needed.** `requireOwner()` returns true whenever `import.meta.env.DEV`,
  so owner-only pages (`/month/*`, `/films/diary`, activities) render as the owner.
- **Give the route without a leading slash.** Git Bash rewrites `/month/2026-08`
  into `C:/Program Files/Git/month/2026-08` before node ever sees it.
- **It does not collide with another worktree's dev server**, which the project's
  own `astro dev` refuses to run twice — this one is its own process on its own
  port and shuts down when the shot is taken.
- Photo 404s are normal locally (no production R2 bucket); the script prints them
  rather than failing.

## Shooting a state that takes more than one click

`--click` may be repeated, and the clicks run in order before the shot:

```
npm run shot -- films/diary/547 tmp/open.png   --click "[data-open-entry-editor]" --click "#ee-private-toggle"
```

That is how a modal's *inner* state gets looked at — the dialog is hidden in the
served HTML, so a single click only ever reaches its first screen. Sequenced
clicks were added for the private-note disclosure in EntryEditor; anything with a
toggle inside a dialog needs them.

## Why not the alternatives

The browser pane refuses `file://` and denies navigation to ports it wasn't given,
and it isn't available in every session. `html-to-image` (already a dependency) only
runs in a browser. Playwright is a devDependency, so it costs nothing at build or
runtime and is there for every agent that clones the repo.
