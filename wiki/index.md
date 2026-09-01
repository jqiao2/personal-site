# Wiki index

Catalog of accumulated patterns. Scan this before non-trivial work; open any whose
"applies when" matches. See `README.md` for the loop. Add a line here whenever you
add or update a pattern.

| # | Title | Type | Applies when |
|---|-------|------|--------------|
| [0001](patterns/0001-supabase-cli-in-worktrees.md) | Supabase CLI in git worktrees | failure-mode | running `supabase db push`/`link` from a worktree |
| [0002](patterns/0002-screenshot-the-page-yourself.md) | Screenshot the page yourself | strategy | changing anything visual — layout, a share card, a chart, a map |
| [0003](patterns/0003-view-columns-need-a-drop.md) | `create or replace view` cannot change a column list | failure-mode | a migration adds a table column behind a view, or removes a view column |
| [0004](patterns/0004-localday-in-frontmatter-is-utc.md) | `localDay()` in Astro frontmatter is UTC | failure-mode | defaulting a date field to "today" |
