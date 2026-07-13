-- How each film was watched: medium (theater / tv / computer / plane / …), and,
-- when in a theater, the venue and the presentation format. Until now this lived
-- in free-text diary tags ("theater", "34th", "imax"); this migration adds real
-- columns + lookup tables, and the backfill (scripts/backfill-medium.mjs) parses
-- the tags into them.
--
-- Each `logs` row is one viewing event, so medium/theater/format are a natural 1:1
-- with a log — plain columns, not a side table. Non-theater viewings leave
-- theater_id and format_id null.
--
-- On `medium` as TEXT (not an enum): the composer offers a fixed set (theater, tv,
-- computer, plane) plus a free-text "Other…", and the historical tags include
-- "bike". A Postgres enum would need an ALTER TYPE every time a new medium shows
-- up; a plain text column (small, stable, app-validated) avoids that — the same
-- reasoning that makes `formats` a lookup table rather than an enum.

-- ---------------------------------------------------------------------------
-- theaters: one row per venue, normalized so we can later answer "what have I
-- seen at the Angelika" and offer autocomplete. name+city is the identity.
-- ---------------------------------------------------------------------------
create table if not exists public.theaters (
	id   bigint generated always as identity primary key,
	name text not null,
	city text,
	unique (name, city)
);

-- ---------------------------------------------------------------------------
-- formats: flat, extensible set of presentation formats. A lookup table (not an
-- enum) so a new gimmick is just a new row, and combos live as their own row
-- ("IMAX 70mm", "IMAX 3D") rather than being modelled as separate fields.
-- ---------------------------------------------------------------------------
create table if not exists public.formats (
	id   bigint generated always as identity primary key,
	name text not null unique   -- e.g. 'Digital','35mm','70mm','IMAX','IMAX 70mm','Dolby Cinema'
);

-- ---------------------------------------------------------------------------
-- logs: how this specific viewing happened.
-- ---------------------------------------------------------------------------
alter table public.logs
	add column if not exists medium     text,    -- 'theater','tv','computer','plane','bike', free text, or null
	add column if not exists theater_id bigint references public.theaters (id),
	add column if not exists format_id  bigint references public.formats (id);

-- theater_id / format_id are only meaningful for medium = 'theater'; everything
-- else leaves them null (enforced at the app layer, per the design).

create index if not exists logs_theater_id_idx on public.logs (theater_id);
create index if not exists logs_format_id_idx  on public.logs (format_id);

-- ---------------------------------------------------------------------------
-- RLS: publicly readable, writes only via the service-role key (same pattern as
-- every other table here).
-- ---------------------------------------------------------------------------
alter table public.theaters enable row level security;
alter table public.formats  enable row level security;
drop policy if exists "public read theaters" on public.theaters;
drop policy if exists "public read formats"  on public.formats;
create policy "public read theaters" on public.theaters for select using (true);
create policy "public read formats"  on public.formats  for select using (true);

-- ---------------------------------------------------------------------------
-- Recreate the frontend view with medium + resolved theater/format. CREATE OR
-- REPLACE VIEW can only APPEND columns (never insert/rename), so the four new
-- fields go at the END, after the existing 0005 column list — consumers select
-- by name, so trailing position is fine.
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
	) as tags,
	l.medium,
	th.name as theater_name,
	th.city as theater_city,
	fm.name as format
from public.logs l
join public.movies m on m.id = l.movie_id
left join public.theaters th on th.id = l.theater_id
left join public.formats  fm on fm.id = l.format_id
where l.deleted_at is null;
