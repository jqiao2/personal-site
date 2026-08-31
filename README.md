# personal-site

A personal website that doubles as a private life log: film diary, book log,
restaurant log, and an activity/training tracker, plus a public home feed that
stitches the shareable parts together. Built with [Astro](https://astro.build),
backed by Supabase, and deployed on Vercel.

It's built for a single owner (me), but nothing stops you from running it as
your own. This README is written for that: cloning it, wiring up the services,
and getting it live under your name.

## What's in it

Most of the site is owner-only — you log in and it becomes your dashboard. A
smaller public surface is what a visitor sees.

- **Films** (`/films`) — a diary of what you watch, ratings, a watchlist, and a
  cast/crew "credit network" graph. Metadata comes from TMDB. Optional Jellyfin
  button plays a film straight off your own server.
- **Books** (`/books`) — a reading log fed by a KOReader plugin on your e-reader
  (see `scripts/reading-plugin-install.mjs`) with a StoryGraph importer.
- **Restaurants** (`/restaurants`) — a log of places with photos, tags, and a
  map. Photos live in Cloudflare R2; the map uses MapTiler tiles.
- **Activities** (`/activities`) — runs/rides/etc. imported from a Strava
  archive, with gear tracking, a heatmap, and training views.
- **Home + journal** (`/`, `/month`) — a public cross-section feed and an RSS
  feed (`/rss.xml`) combining the shareable entries.
- **Subway map** (`/subway`) — a hand-built SVG side project.

If you only want some of these, you can delete the pages you don't want; each
lives under its own folder in `src/pages/`.

## Stack

| Piece | What it does | Required? |
| :---- | :----------- | :-------- |
| Astro 7 | The framework. Static by default; API routes opt into serverless. | Yes |
| Supabase (Postgres) | All the log data. Schema is in `supabase/migrations/`. | Yes |
| Vercel | Hosting + serverless runtime + image optimizer. | Yes (or adapt the adapter) |
| TMDB | Film/show metadata. | Only for `/films` |
| Cloudflare R2 | Restaurant photo storage. | Only for `/restaurants` |
| MapTiler | Vector map tiles. | Optional (map degrades gracefully) |
| Jellyfin | "Play" button on film pages. | Optional |

## Setup

### 1. Clone and install

```sh
git clone <your-fork-url> personal-site
cd personal-site
npm install
```

Requires Node ≥ 22.12.

### 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/local-development)
   and link it to your project (`supabase link`).
3. Apply the schema — every table, view, and function is a numbered migration in
   `supabase/migrations/`, applied in order:

   ```sh
   supabase db push
   ```

   > **Migrations are the source of truth.** Anything you change in the database
   > must land as a new `NNNN_name.sql` file — the number is the recorded
   > version, so it must be unique and never reused. Applying SQL by hand (via
   > the dashboard or MCP) without committing the matching file breaks a fresh
   > rebuild. See `CLAUDE.md` for the full rules.

### 3. Configure environment variables

Copy the example file and fill it in. It's the real reference — each variable is
documented inline, including which are safe to expose and which must stay
server-side:

```sh
cp .env.example .env
```

At minimum you need the **Supabase** keys and **owner auth** (`ADMIN_PASSWORD`,
`SESSION_SECRET`). Generate the session secret with:

```sh
openssl rand -hex 32
```

Add TMDB / R2 / MapTiler / Jellyfin only if you want the features that use them.
The site is written to degrade when an optional service is unset (the map draws
pins without streets, the Jellyfin button doesn't render, etc.) rather than
error out.

`R2_PUBLIC_URL` is read at build time by `astro.config.mjs` — it must be set
even if the bucket is empty, because the Vercel image optimizer needs the
photo host declared. If you strip out the restaurant log entirely, remove that
check too.

### 4. Run it

```sh
npm run dev        # http://localhost:4321
```

On a local dev server **you are treated as the owner without logging in**, so
the owner-only half of the site is editable. To browse as a stranger — to check
what a visitor is and isn't allowed to see — set `OWNER_DEV=0` in `.env`. This
never applies to a production build; see `src/lib/auth.ts`.

### 5. Deploy

Push to a repo and import it into [Vercel](https://vercel.com). Set the same
environment variables in the Vercel project settings. Update `site:` in
`astro.config.mjs` to your own domain (it drives absolute URLs in the RSS feed).

## Importing your own data

Most logs are populated by scripts under `scripts/`, run through `npm`:

| Command | What it does |
| :------ | :----------- |
| `npm run activities:import` | Import a Strava data-export archive |
| `npm run restaurants:import` | Seed the restaurant "to try" list |
| `npm run credits:build` | Build the film credit-network graph |

Books sync from a KOReader plugin (`scripts/reading-plugin-install.mjs`) or a
StoryGraph export (`scripts/import-storygraph.mjs`). Browse `scripts/` for the
one-off backfill and import helpers.

## Commands

| Command | Action |
| :------ | :----- |
| `npm run dev` | Local dev server at `localhost:4321` |
| `npm run build` | Build the production site to `./dist/` |
| `npm run preview` | Preview the build locally |
| `npm run astro ...` | Astro CLI (`astro add`, `astro check`, …) |
| `npm run *:test` | Test runners for individual subsystems — see `package.json` |

## Project layout

```text
src/
├── pages/        route = file path; API routes under pages/api/
├── layouts/      per-section page shells
├── components/   shared Astro components
└── lib/          server-side data access, auth, helpers
supabase/
└── migrations/   the database schema, numbered and ordered
scripts/          data import / backfill / one-off tooling
wiki/             an agent-maintained knowledge base (see CLAUDE.md)
```

## Notes

- `CLAUDE.md` holds working conventions (migrations, dev-server, the `wiki/`
  knowledge base) — worth a read if you're going to develop on it.
- The whole thing is single-owner by design. Turning it into a multi-user app
  would mean reworking `src/lib/auth.ts` and adding a user column to every
  table; that's a rewrite, not a config flag.
