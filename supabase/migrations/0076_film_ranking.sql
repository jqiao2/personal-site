-- The owner's head-to-head ranking of every watched film, built on /films/rank
-- one A-or-B comparison at a time over several days.
--
-- One row holding the whole order, best first, as `movies.id`s (not tmdb ids,
-- which fix-tmdb-id can relink). Every insert shifts the positions of everything
-- below it, so a row-per-film table would rewrite ~1k rows per answer; the array
-- is one small write. Ids of films no longer watched are dropped on read.
create table if not exists public.film_ranking (
	id         smallint primary key default 1 check (id = 1),
	movie_ids  integer[] not null default '{}',
	updated_at timestamptz not null default now()
);

-- RLS on, no policies: only the owner API touches it, through the service role.
alter table public.film_ranking enable row level security;
