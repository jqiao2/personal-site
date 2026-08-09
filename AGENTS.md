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
