-- Credit graph: who worked with whom, across a broad slice of TMDB.
--
-- Unrelated to the film-log tables. Those model the OWNER'S relationship to a
-- movie; this models the FILM INDUSTRY'S internal structure — a bipartite
-- person↔film credit table that gets projected into a collaboration network
-- (nodes = people, edges = films shared) for the /projects/credit-network page.
--
-- It is kept in its own `credit_*` namespace rather than reusing `movies`
-- because the corpus is ~23k films — two orders of magnitude larger than the
-- diary — and is a disposable, fully-rederivable TMDB mirror. Dropping and
-- rebuilding it must never touch the diary.
--
-- Populated by scripts/credit-graph/{fetch,load}.mjs. Reads are public; writes
-- go through the service-role key, matching the rest of the schema.
--
-- Run with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- credit_roles: the kinds of credit we graph
-- ---------------------------------------------------------------------------
-- A lookup table rather than a check constraint, because expanding to a new
-- credit type (writer, cinematographer, editor…) should be an INSERT, not a
-- schema change. It also parks the per-role presentation and filtering rules
-- next to the role itself, so the graph builder reads its thresholds from here
-- instead of hard-coding them.
create table if not exists public.credit_roles (
	role       text primary key,          -- stored in credits.role
	label      text    not null,          -- display name, e.g. "Composer"
	color      text    not null,          -- node colour, hex
	min_films  integer not null,          -- graph filter: min credits to appear as a node
	sort_order smallint not null          -- legend / pie-slice ordering
);

insert into public.credit_roles (role, label, color, min_films, sort_order) values
	('actor',    'Actor',    '#e0574f', 10, 1),
	('director', 'Director', '#4a8fd4',  5, 2),
	('composer', 'Composer', '#3fa87a',  3, 3)
on conflict (role) do nothing;

-- ---------------------------------------------------------------------------
-- credit_films: the corpus (a TMDB mirror, not a source of truth)
-- ---------------------------------------------------------------------------
create table if not exists public.credit_films (
	tmdb_id      integer primary key,     -- TMDB movie id
	title        text    not null,
	release_year smallint,                -- null when TMDB has no release date
	vote_count   integer not null default 0,  -- the corpus threshold was applied to this
	vote_average real,
	popularity   real,
	synced_at    timestamptz not null default now()
);

-- Lets the builder slice the corpus by era, and rank films within an edge's
-- shared-film list by prominence.
create index if not exists credit_films_release_year_idx on public.credit_films (release_year);
create index if not exists credit_films_vote_count_idx   on public.credit_films (vote_count desc);

-- ---------------------------------------------------------------------------
-- credit_people: graph nodes
-- ---------------------------------------------------------------------------
create table if not exists public.credit_people (
	tmdb_id integer primary key,          -- TMDB person id
	name    text not null
);

create index if not exists credit_people_name_idx on public.credit_people (name);

-- ---------------------------------------------------------------------------
-- credits: the bipartite person↔film edges everything is derived from
-- ---------------------------------------------------------------------------
-- The primary key is (film_id, person_id, role): one person can hold two
-- different roles on the same film (the actor-directors the graph colours
-- half-and-half), but not the same role twice.
create table if not exists public.credits (
	film_id   integer not null references public.credit_films (tmdb_id) on delete cascade,
	person_id integer not null references public.credit_people (tmdb_id) on delete cascade,
	role      text    not null references public.credit_roles (role),
	billing   smallint,                   -- cast order (0 = top-billed); null for crew
	primary key (film_id, person_id, role)
);

-- The two directions the graph build walks: "every credit for this person"
-- (to count films per role and filter nodes) and "everyone on this film"
-- (to project co-credits into collaboration edges).
create index if not exists credits_person_role_idx on public.credits (person_id, role);
create index if not exists credits_film_idx        on public.credits (film_id);

-- ---------------------------------------------------------------------------
-- RLS: public read, service-role write (same posture as the film-log tables)
-- ---------------------------------------------------------------------------
alter table public.credit_roles  enable row level security;
alter table public.credit_films  enable row level security;
alter table public.credit_people enable row level security;
alter table public.credits       enable row level security;

drop policy if exists "public read credit_roles"  on public.credit_roles;
drop policy if exists "public read credit_films"  on public.credit_films;
drop policy if exists "public read credit_people" on public.credit_people;
drop policy if exists "public read credits"       on public.credits;

create policy "public read credit_roles"  on public.credit_roles  for select using (true);
create policy "public read credit_films"  on public.credit_films  for select using (true);
create policy "public read credit_people" on public.credit_people for select using (true);
create policy "public read credits"       on public.credits       for select using (true);
