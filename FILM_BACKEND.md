# Film log backend

Backend for the film diary ("Letterboxd clone"): a TMDB proxy plus a Supabase
Postgres store for your watches and watchlist. Single-user — only you write,
everyone can read.

## Architecture

- **Astro API routes** (`src/pages/api/**`, server-rendered via the Vercel
  adapter) proxy TMDB and handle writes. The TMDB key and Supabase service-role
  key stay server-side.
- **Supabase Postgres** (`supabase/migrations/`) owns *your relationship* to a
  movie (logs, ratings, watchlist, watched). Movie metadata is a lightweight
  cache refreshed from TMDB on demand.
- **Owner auth** is one password + a signed cookie (`src/lib/auth.ts`). No
  Supabase Auth needed for a single user.

## Setup

1. `cp .env.example .env` and fill in all values (TMDB key, Supabase URL + both
   keys, an admin password, and a random `SESSION_SECRET`).
2. Apply the schema — see [Migrations](#migrations) below.
3. `npm run dev` (local) or deploy to Vercel with the same env vars set in the
   project settings.

## Migrations

SQL lives in `supabase/migrations/`, applied in filename order (`0001_…`,
`0002_…`, …). Prefer the CLI over pasting into the SQL editor so migration
history stays in sync.

**One-time CLI setup** (the repo isn't linked yet):

```bash
npx supabase init                       # creates supabase/config.toml
npx supabase link --project-ref <ref>   # <ref> = the subdomain in SUPABASE_URL
```

**Apply all pending migrations** (this is the "run everything on command" step):

```bash
npx supabase db push
```

**Gotcha — migrations applied by hand:** `db push` records what it has run in
`supabase_migrations.schema_migrations`. Any migration you ran manually in the
SQL editor isn't recorded, so a push would try to re-run it and fail (renames
and `create policy` aren't idempotent). Mark those as already applied first:

```bash
npx supabase migration list                        # local vs remote status
npx supabase migration repair --status applied 0001 0002
```

New migration → new `000N_name.sql` file → `db push`. Keep the numeric prefixes
monotonic.

## Endpoints

Reads are public; writes require the owner cookie (log in first).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/tmdb/search?query=&page=` | – | Live search (debounce client input ~300ms) |
| GET | `/api/tmdb/movie/:id` | – | Full details + credits + videos + similar |
| GET | `/api/tmdb/trending` | – | Trending this week |
| GET | `/api/tmdb/genres` | – | Genre id→name list |
| POST | `/api/auth/login` `{password}` | – | Set session cookie |
| POST | `/api/auth/logout` | – | Clear session cookie |
| GET | `/api/films/logs?limit=&offset=` | – | List watches (newest first) |
| POST | `/api/films/logs` | owner | Create a watch |
| PATCH | `/api/films/logs/:id` | owner | Edit a watch |
| DELETE | `/api/films/logs/:id` | owner | Delete a watch |
| GET | `/api/films/watchlist` | – | List watchlist |
| POST | `/api/films/watchlist` `{tmdbId}` | owner | Add to watchlist |
| DELETE | `/api/films/watchlist?tmdbId=` | owner | Remove from watchlist |

### Create-a-log body

```json
{
  "tmdbId": 78,
  "watchedDate": "2026-07-10",
  "rating": 4.5,
  "reviewText": "Still holds up.",
  "rewatched": true,
  "liked": true,
  "tags": ["sci-fi", "rewatch-night"]
}
```

Only `tmdbId` is required. `rating` is 0.5–5.0 in half-steps. Logging a movie
auto-caches its TMDB metadata into the `movies` table.

## Notes / gotchas

- **Image URLs** aren't returned by TMDB — build them with `imageUrl(path, size)`
  from `src/lib/tmdb.ts`. `poster_path` can be `null`; always have a placeholder.
- **Attribution:** TMDB's terms require crediting them — add the TMDB logo/text
  to the site footer or an about page.
- **Rate limits** are generous (~50 req/s) but debounce search keystrokes so a
  fast typist doesn't fan out one request per character.
- The `logs_with_movie` view flattens a log + its movie + tag names for easy
  frontend rendering.
