-- Adds a `watched` table (first-watch-per-movie) and evolves the `logs` table.
--
-- CSV exports (Letterboxd: diary/watched/ratings/reviews) describe the shape of
-- data to eventually import — this migration only sets up the schema. It does
-- NOT backfill any rows; import happens separately.

-- ---------------------------------------------------------------------------
-- logs: evolve to match the diary model
-- ---------------------------------------------------------------------------
-- `movie_id` is intentionally NOT unique — one movie can have many watches
-- (rewatches). It's already indexed by `logs_movie_id_idx` from 0001.

-- Drop the dependent view first so the column rename/add can't be blocked by it;
-- it's recreated at the bottom against the new column names.
drop view if exists public.logs_with_movie;

-- `rewatch` -> `rewatched`: same meaning (this log is a rewatch of the movie),
-- renamed for consistency with the rest of the schema.
alter table public.logs rename column rewatch to rewatched;

-- `log`: the diary date — WHEN the entry was logged, distinct from
-- `watched_date` (when the film was seen) and `created_at` (row insert time).
-- Maps to the diary.csv "Date" column. Nullable until backfilled.
alter table public.logs add column if not exists log date;

-- Index the diary date so the log can be ordered/queried by when entries were made.
create index if not exists logs_log_idx on public.logs (log desc);

-- ---------------------------------------------------------------------------
-- watched: one row per movie, capturing the FIRST time it was watched.
-- ---------------------------------------------------------------------------
-- Unlike `logs` (one row per watch), a movie appears here at most once.
create table if not exists public.watched (
	id            bigint generated always as identity primary key,
	movie_id      bigint not null unique references public.movies (id) on delete cascade,
	first_watched timestamptz not null,   -- timestamp of first watch
	tmdb_url      text,                    -- link to the movie on TMDB
	created_at    timestamptz not null default now()
);

-- Order/query the collection by when each film was first seen.
create index if not exists watched_first_watched_idx on public.watched (first_watched desc);

-- ---------------------------------------------------------------------------
-- Row-level security: publicly readable, writes only via service-role key.
-- ---------------------------------------------------------------------------
alter table public.watched enable row level security;
create policy "public read watched" on public.watched for select using (true);

-- ---------------------------------------------------------------------------
-- Recreate the frontend view with the renamed column (+ the new `log` date).
-- ---------------------------------------------------------------------------
create or replace view public.logs_with_movie as
select
	l.id,
	l.watched_date,
	l.log,
	l.rating,
	l.review_text,
	l.rewatched,
	l.liked,
	l.created_at,
	m.tmdb_id,
	m.title,
	m.release_year,
	m.poster_path,
	coalesce(
		(select array_agg(t.name order by t.name)
		 from public.log_tags lt
		 join public.tags t on t.id = lt.tag_id
		 where lt.log_id = l.id),
		'{}'
	) as tags
from public.logs l
join public.movies m on m.id = l.movie_id;
