# Wiki index

Catalog of accumulated patterns. Scan this before non-trivial work; open any whose
"applies when" matches. See `README.md` for the loop. Add a line here whenever you
add or update a pattern.

| # | Title | Type | Applies when |
|---|-------|------|--------------|
| [0001](patterns/0001-supabase-cli-in-worktrees.md) | Supabase CLI in git worktrees | failure-mode | running `supabase db push`/`link` from a worktree |
| [0002](patterns/0002-screenshot-the-page-yourself.md) | Screenshot the page yourself | strategy | changing anything visual — layout, a share card, a chart, a map |
| [0003](patterns/0003-view-columns-need-a-drop.md) | `create or replace view` cannot change a column list | failure-mode | a migration adds a table column behind a view, or removes a view column |
| [0004](patterns/0004-powershell-corrupts-utf8-files.md) | PowerShell corrupts UTF-8 files | failure-mode | rewriting/truncating a source file via PowerShell or shell text tools |
| [0005](patterns/0005-localday-in-frontmatter-is-utc.md) | `localDay()` in Astro frontmatter is UTC | failure-mode | defaulting a date field to "today" |
| [0006](patterns/0006-ski-lift-run-detection.md) | Segment a ski day into runs and lifts | strategy | ski/board exertion, run counts, or any climb/descent GPS track |
| [0007](patterns/0007-siteheader-full-bleed-and-column.md) | Placing SiteHeader on a page that centres its own column | strategy | adding the site header to a page, or auditing which pages have one |
| [0008](patterns/0008-gazetteer-only-had-dohmh.md) | The place gazetteer only ever had one of its four sources | failure-mode | a known restaurant is missing from suggestions, a suggestion is ALL CAPS, or co-located venues collapse into one |
| [0009](patterns/0009-beli-export-import.md) | Getting a Beli account's lists out, and into the log | strategy | exporting Beli data, or talking to a reverse-engineered app backend behind a bot gate |
| [0010](patterns/0010-astro-check-fails-in-worktrees.md) | Dev server/`astro check` fail in a worktree when MAIN has no `node_modules` | failure-mode | dev server or `astro sync` dies with "Tsconfig not found astro/tsconfigs/strict" in a `.claude/worktrees/*` checkout |
| [0011](patterns/0011-applying-a-migration-without-the-cli.md) | Applying a migration when there is no linked Supabase project | strategy | a migration must reach the live DB and `supabase link`/`db push` isn't available |
| [0012](patterns/0012-stretched-svg-turns-dots-into-ovals.md) | A stretched SVG turns every dot into an oval | failure-mode | an inline SVG chart is sized with `width: 100%` / `preserveAspectRatio="none"` |
| [0013](patterns/0013-vite-outdated-optimize-dep-after-new-shared-import.md) | Vite "504 Outdated Optimize Dep" after a new module imports a heavy dep | failure-mode | a new lib/component imports a pre-bundled dep mid-session and a `<script>` dynamic-imports it |
