# `npm run shot` fires at networkidle, before a client-settled graph paints

**Type:** failure-mode
**Applies when:** screenshotting a page whose visible content is produced by a
client-side animation/layout that starts *after* load — the credit-network
graphs (`/projects/credit-network`, `/projects/film-credit-network`), which run
ForceAtlas2 in a worker and paint over the next few seconds.

## What happens

`scripts/shot.mjs` waits for `waitUntil: 'networkidle'` then `document.fonts.ready`
and shoots immediately. A force-directed graph is seeded on a circle and settled
by a worker on a timer, so at networkidle it is either unpainted (blank canvas,
maybe a lone `#loading` spinner) or mid-explode (a few stray edges spanning the
canvas, nodes flung off-frame). The screenshot looks broken though the page is
fine — you conclude the render failed when it just had not started.

## Fix

Don't touch `shot.mjs` (it is right for static pages). Drop a throwaway
Playwright script in `tmp/` (so `import 'playwright'` resolves against the
project's `node_modules`) that points at the already-running dev server and adds
`await page.waitForTimeout(5000)` after `fonts.ready`. ~5–7s covers a burst
settle. Capture console/pageerror too — that is how the settle-on-load and
theme bugs surfaced.

Two adjacent traps hit at the same time:

- **504 Outdated Optimize Dep** on first load after a page pulls in a heavy dep
  (sigma/graphology) mid-session — pattern 0013. Dev-only; reload once.
- **`prefers-color-scheme` is `light` headless.** A page that pins its own dark
  palette must tell the client renderer which theme to use (we added
  `meta.forceTheme`); relying on `matchMedia` gives light-mode edge colours on a
  dark surface — a washed-out white-out that reads as "too dense" but is really
  the wrong palette.

See also [0002](0002-screenshot-the-page-yourself.md), [0013](0013-vite-outdated-optimize-dep-after-new-shared-import.md).
