## Agent knowledge base (WikiSkill)

This repo keeps a persistent, compounding knowledge base in `wiki/`, adapted from
WikiSkill (arXiv:2608.27454). Run this loop:

- **Before non-trivial work**, read `wiki/index.md` and open any pattern whose
  "applies when" matches the task.
- **After finishing**, if you hit a failure/dead end or found a reusable strategy,
  root-cause it into a `wiki/patterns/NNNN-slug.md` file, add its row to
  `wiki/index.md`, and append one dated line to `wiki/logs.md`. Do this even if the
  task failed — the lesson persists.
- **Promote** a pattern's actionable core into this file once it has proven useful
  across more than one session. The wiki is never reset; see `wiki/README.md`.

## Visual checks

Anything whose correctness is visual — layout, overlap, a share card, a chart —
gets looked at, not reasoned about:

```
npm run shot -- month/2026-08                                  # → tmp/shot.png
npm run shot -- month/2026-08 tmp/card.png --el "[data-card]"  # one element
npm run shot -- films tmp/films.png --width 1400 --full
```

`scripts/shot.mjs` starts its own dev server, shoots with Playwright at 2x and
stops again — open the PNG with the Read tool. It needs `.env` in the worktree
(`cp ../../../.env .env`; worktrees don't inherit untracked files). Owner-only
pages need no login: `requireOwner()` is true in dev. Pass the route WITHOUT a
leading slash — Git Bash rewrites `/month` into a Windows path. See
`wiki/patterns/0002-screenshot-the-page-yourself.md`.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Database migrations

Schema lives in `supabase/migrations/`, named `NNNN_name.sql` and applied in
order. The number is the version recorded in the database, so it must be unique
and must never be reused.

**Anything applied to the project must be committed as a file with it.** Running
SQL through the Supabase dashboard, the MCP tools or by hand without adding the
matching migration breaks the repo in two ways, both of which have happened
here:

- The repo can no longer rebuild the database. A fresh `supabase db push`
  produces a schema missing whatever was only ever applied by hand.
- A later file that reuses the taken number is **silently skipped**.
  `supabase db push` compares versions against the applied history, not
  contents, so it sees the number is applied and never reads the file. Editing
  that file afterwards ships nothing.

Before writing a migration, check the applied history as well as the directory
— they can disagree. With the Supabase MCP that is `list_migrations`; the same
rows are in `supabase_migrations.schema_migrations`, whose `statements` column
holds the SQL of anything applied without a file, should one need
reconstructing. See `0027_merge_duplicate_theaters.sql`, which was recovered
that way.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
