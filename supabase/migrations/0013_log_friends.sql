-- Who I watched a film with. A viewing is a shared event as often as not, and
-- until now the only place that fact could live was the review prose.
--
-- Modelled exactly like tags (a `friends` lookup + a `log_friends` join) because
-- the shape is the same: many friends per viewing, one friend across many
-- viewings, and a stable name set worth autocompleting. Keeping them as their own
-- table rather than reusing `tags` means "watched with Mia" can later answer
-- "what have we seen together" without teasing people back out of the tag soup.
--
-- One deliberate difference from tags: tag names are normalized to lowercase
-- ("slow cinema"), but these are people's names, so the stored casing is whatever
-- was typed ("Mia Tanaka"). Uniqueness is therefore enforced case-sensitively by
-- the constraint below, and the app layer resolves names case-insensitively
-- before inserting so "mia tanaka" links to the existing "Mia Tanaka" row rather
-- than creating a twin.

create table if not exists public.friends (
	id   bigint generated always as identity primary key,
	name text not null unique
);

create table if not exists public.log_friends (
	log_id    bigint not null references public.logs (id) on delete cascade,
	friend_id bigint not null references public.friends (id) on delete cascade,
	primary key (log_id, friend_id)
);

create index if not exists log_friends_friend_id_idx on public.log_friends (friend_id);

-- ---------------------------------------------------------------------------
-- RLS: publicly readable, writes only via the service-role key (same pattern as
-- every other table here).
-- ---------------------------------------------------------------------------
alter table public.friends     enable row level security;
alter table public.log_friends enable row level security;
drop policy if exists "public read friends"     on public.friends;
drop policy if exists "public read log_friends" on public.log_friends;
create policy "public read friends"     on public.friends     for select using (true);
create policy "public read log_friends" on public.log_friends for select using (true);

-- ---------------------------------------------------------------------------
-- Recreate the frontend view with the friend names aggregated alongside tags.
-- CREATE OR REPLACE VIEW can only APPEND columns (never insert/rename), so
-- `friends` goes at the END, after 0010's medium/theater/format — consumers
-- select by name, so trailing position is fine.
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
	fm.name as format,
	coalesce(
		(select array_agg(f.name order by f.name)
		 from public.log_friends lf
		 join public.friends f on f.id = lf.friend_id
		 where lf.log_id = l.id),
		'{}'
	) as friends
from public.logs l
join public.movies m on m.id = l.movie_id
left join public.theaters th on th.id = l.theater_id
left join public.formats  fm on fm.id = l.format_id
where l.deleted_at is null;
