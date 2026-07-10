-- Film log ("Letterboxd clone") schema — single-user diary.
--
-- Design: the DB owns the OWNER'S RELATIONSHIP to a movie (logs, ratings,
-- watchlist), NOT the movie metadata. `movies` is a lightweight local cache of
-- TMDB so we can sort/query by title/poster and do fast "did I log this?"
-- lookups without hitting TMDB on every page load. Fresh detail (cast, trailers,
-- providers) is fetched from TMDB on demand and lightly refreshed.
--
-- Single-user: there are no per-row user_id columns. Reads are public; writes go
-- through server endpoints using the service-role key (which bypasses RLS).
-- Run with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- movies: lightweight TMDB cache (NOT the source of truth)
-- ---------------------------------------------------------------------------
create table if not exists public.movies (
	id             bigint generated always as identity primary key,
	tmdb_id        integer not null unique,
	title          text    not null,
	release_year   smallint,
	poster_path    text,               -- TMDB path fragment, e.g. /abc.jpg (may be null)
	backdrop_path  text,
	overview       text,
	runtime        integer,            -- minutes
	last_synced_at timestamptz not null default now(),
	created_at     timestamptz not null default now()
);

-- Fast lookups by TMDB id (the unique constraint already indexes this) and title.
create index if not exists movies_title_idx on public.movies (title);

-- ---------------------------------------------------------------------------
-- logs: one row per "watch"
-- ---------------------------------------------------------------------------
create table if not exists public.logs (
	id           bigint generated always as identity primary key,
	movie_id     bigint not null references public.movies (id) on delete cascade,
	watched_date date,                                        -- null = "not specified"
	rating       numeric(2, 1) check (rating >= 0.5 and rating <= 5.0
	                                   and (rating * 2) = floor(rating * 2)),  -- 0.5–5.0 in half-steps
	review_text  text,
	rewatch      boolean not null default false,
	liked        boolean not null default false,             -- Letterboxd-style "like"
	created_at   timestamptz not null default now()
);

create index if not exists logs_movie_id_idx     on public.logs (movie_id);
create index if not exists logs_watched_date_idx on public.logs (watched_date desc);

-- ---------------------------------------------------------------------------
-- tags + log_tags (many-to-many)
-- ---------------------------------------------------------------------------
create table if not exists public.tags (
	id   bigint generated always as identity primary key,
	name text not null unique
);

create table if not exists public.log_tags (
	log_id bigint not null references public.logs (id) on delete cascade,
	tag_id bigint not null references public.tags (id) on delete cascade,
	primary key (log_id, tag_id)
);

create index if not exists log_tags_tag_id_idx on public.log_tags (tag_id);

-- ---------------------------------------------------------------------------
-- watchlist: a movie can be on the list at most once
-- ---------------------------------------------------------------------------
create table if not exists public.watchlist (
	id       bigint generated always as identity primary key,
	movie_id bigint not null unique references public.movies (id) on delete cascade,
	added_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Everything is publicly READABLE (it's a public film diary). Nothing is
-- writable by the anon/authenticated roles — writes only succeed via the
-- service-role key, which bypasses RLS and is used server-side by the API
-- routes after they verify the owner's session cookie.
alter table public.movies    enable row level security;
alter table public.logs      enable row level security;
alter table public.tags      enable row level security;
alter table public.log_tags  enable row level security;
alter table public.watchlist enable row level security;

create policy "public read movies"    on public.movies    for select using (true);
create policy "public read logs"       on public.logs      for select using (true);
create policy "public read tags"       on public.tags      for select using (true);
create policy "public read log_tags"   on public.log_tags  for select using (true);
create policy "public read watchlist"  on public.watchlist for select using (true);

-- ---------------------------------------------------------------------------
-- Convenience view: logs with their movie + tags, ready for the frontend.
-- ---------------------------------------------------------------------------
create or replace view public.logs_with_movie as
select
	l.id,
	l.watched_date,
	l.rating,
	l.review_text,
	l.rewatch,
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
