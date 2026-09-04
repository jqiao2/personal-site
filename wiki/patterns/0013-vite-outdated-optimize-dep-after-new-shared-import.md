# 0013 — Vite "504 Outdated Optimize Dep" after a new module imports a heavy dep

**Type:** failure-mode
**Applies when:** you add a NEW `src/lib/*.ts` (or component) that `import`s a
pre-bundled dependency (e.g. `html-to-image`, `maplibre-gl`) mid-session, and a
`<script>` dynamic-imports it — then the browser throws `504 (Outdated Optimize
Dep)` / "Failed to fetch dynamically imported module … /.vite/deps/<dep>.js?v=…".

## What happens
Vite pre-optimizes deps once at dev-server start and pins a version hash in the
URLs it hands the browser (`?v=ea46e3e8`). When a new module changes the dep
graph, Vite re-optimizes and the old hash 504s. A plain page reload does **not**
fix it — the HTML still references the stale chunk, so the dynamic `import()`
keeps 504ing. In our case this surfaced as the share-card **export silently
failing** ("Could not render the image") right after extracting the html-to-image
call into `src/lib/month-card.ts`.

## Fix
Restart the dev server so Vite re-optimizes from the new graph:

```
rm -rf node_modules/.vite
npx astro dev stop && npx astro dev --background
```

Then hard-reload the page. Nothing is wrong with the code — it builds and runs
fine; only the long-lived dev server's optimize cache was stale.

## Don't misdiagnose
The export ALSO logs `SecurityError: Failed to read 'cssRules'` /
"Error inlining remote css file" for `fonts.googleapis.com` — that is
html-to-image trying to embed cross-origin Google Fonts, which the automated
Browser pane blocks. That one is environmental (a real browser embeds the font
or falls back) and is unrelated to the 504. See [[0002-screenshot-the-page-yourself]].
