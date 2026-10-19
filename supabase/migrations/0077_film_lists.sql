-- Film lists at /films/lists.
--
-- A list is either hand-picked (rows in film_list_items, in `position` order) or
-- smart: `query` holds a /films/watched query string (e.g. `actor=Scarlett+Johansson`
-- or `dmin=2026&dmax=2026`), and its films are whatever that grid shows for it, read
-- through the same parser. A smart list therefore never has items and follows the
-- diary on its own.
create table if not exists public.film_lists (
	id          bigint generated always as identity primary key,
	name        text not null check (length(trim(name)) > 0),
	description text,
	query       text,
	position    integer not null default 0,
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now()
);

-- The primary key leads with list_id, which is every read (one list's films).
create table if not exists public.film_list_items (
	list_id  bigint not null references public.film_lists (id) on delete cascade,
	movie_id bigint not null references public.movies (id) on delete cascade,
	position integer not null default 0,
	added_at timestamptz not null default now(),
	primary key (list_id, movie_id)
);

-- Publicly readable like the rest of the film diary (0001); writes go through
-- the owner API with the service role.
alter table public.film_lists      enable row level security;
alter table public.film_list_items enable row level security;

create policy "public read film_lists"      on public.film_lists      for select using (true);
create policy "public read film_list_items" on public.film_list_items for select using (true);
