-- The restaurant log: the third section of the family.
--
-- The film log models the owner's relationship to a MOVIE; the book log models
-- it to a BOOK; this models it to a PLACE YOU EAT. The shape borrows from the
-- film log rather than the book log, because the data is typed in by hand rather
-- than synced off a device: a `restaurants` row is the place, a
-- `restaurant_visits` row is one meal there, and the interesting opinions hang
-- off the visit.
--
-- Three things here are not in either sibling, and each one earns a table or a
-- column that would otherwise look over-built:
--
--   1. The return verdict. A six-step ordinal scale (see below) that belongs to
--      a VISIT and moves between them. A place's headline verdict is its latest,
--      never a max or a mean.
--   2. Photographs. Neither sibling has user photography. Photos belong to a
--      visit, carry an optional caption, and record their own pixel dimensions
--      so a mixed-orientation grid can be laid out without measuring.
--   3. Location at varying granularity. City/region/country are a guaranteed
--      floor; `neighborhood` is present in New York and absent almost
--      everywhere else, and null is a normal reading rather than a gap.
--
-- Run with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- restaurants — the place, not the meal
-- ---------------------------------------------------------------------------
create table if not exists public.restaurants (
	id              bigint generated always as identity primary key,
	name            text        not null,

	-- Multi-valued on purpose: a place is legitimately "Mexican, Tex-Mex" or
	-- "Sichuan, Hot pot". A controlled list lives in the app; the column is a
	-- free text array so a one-off never needs a migration.
	cuisines        text[]      not null default '{}',

	-- Four steps, no half steps.
	price_band      text        check (price_band is null or price_band in ('$', '$$', '$$$', '$$$$')),

	-- NULLABLE AND NULL A LOT. Strongly present in New York, largely absent
	-- everywhere else. Renders as "Sunset Park, Brooklyn" when set and as plain
	-- "Austin, TX" when not — an absent neighbourhood is the level of detail
	-- that place warrants, not a missing field.
	neighborhood    text,
	city            text        not null,
	state_region    text,
	country         text        not null default 'US',

	-- From an open geocode confirmed by hand at log time: accurate, but the
	-- granularity varies. Nullable so a place can be logged before it is placed.
	lat             double precision check (lat is null or (lat between -90 and 90)),
	lng             double precision check (lng is null or (lng between -180 and 180)),

	-- Never displayed; builds the Google Maps link.
	google_place_id text,
	website_url     text,
	yelp_url        text,
	beli_url        text,

	-- 1–4, or null. Drives the landing page's top-four block, which is
	-- hand-picked and ranked rather than computed.
	favorite_rank   smallint    check (favorite_rank is null or favorite_rank between 1 and 4),

	-- The to-try list is not a separate table: a place you mean to go to is a
	-- restaurant with no visits yet, which is exactly what it is. Set = on the
	-- list. `to_try_reason` is the "why I want to go" the list is mostly made of.
	to_try_added_at timestamptz,
	to_try_reason   text,

	created_at      timestamptz not null default now(),
	updated_at      timestamptz not null default now()
);

comment on column public.restaurants.neighborhood is
	'Nullable and null a lot. Absent means the city is the right granularity for that place, not that a field is missing.';
comment on column public.restaurants.to_try_added_at is
	'Non-null = on the to-try list. A place drops off the list by being visited, not by being edited.';
comment on column public.restaurants.favorite_rank is
	'1-4 for the landing page''s hand-picked top four. Unique among non-null values.';

-- One place per rank, but any number of places at no rank.
create unique index if not exists restaurants_favorite_rank_key
	on public.restaurants (favorite_rank)
	where favorite_rank is not null;

create index if not exists restaurants_name_idx     on public.restaurants (lower(name));
create index if not exists restaurants_city_idx     on public.restaurants (city);
create index if not exists restaurants_cuisines_idx on public.restaurants using gin (cuisines);
create index if not exists restaurants_to_try_idx
	on public.restaurants (to_try_added_at desc)
	where to_try_added_at is not null;

-- ---------------------------------------------------------------------------
-- restaurant_visits — one meal
-- ---------------------------------------------------------------------------
-- Three overlapping opinions live here and they are not redundant:
--   rating  — how good was it
--   verdict — how much do I want to go back and repeat it
--   hearted — do I love it
-- All three are nullable/false-able; the common entry has a name, a place and a
-- verdict and nothing else.
create table if not exists public.restaurant_visits (
	id            bigint generated always as identity primary key,
	restaurant_id bigint      not null references public.restaurants (id) on delete cascade,

	-- A date, not a timestamp. Nobody remembers what time they sat down.
	visited_on    date        not null,

	rating        numeric(2,1) check (
		rating is null or (rating >= 0.5 and rating <= 5.0 and (rating * 2) = floor(rating * 2))
	),

	-- The return verdict, as an ordinal rank, best first. The scale is strictly
	-- ordered and the order is settled:
	--   0  Definitely return   I'd come back and order the same thing again
	--   1  Worth returning     I'd come back of my own accord, but it's too
	--                          expensive or too far to be likely
	--   2  Try something else  I'd come back, but I wouldn't order what I ordered
	--   3  Happy to go         I wouldn't pick it myself, but I'd go if someone
	--                          else suggested it
	--   4  No return           Would not go again
	--   5  Avoid               Would actively recommend that others not go
	--
	-- The axis is how much of the visit I would repeat, not how likely a return
	-- actually is. Stored as a rank rather than an enum because every consumer
	-- wants to sort, threshold ("worth returning or better") and interpolate a
	-- glyph angle from it, and an enum makes all three awkward.
	verdict       smallint    check (verdict is null or verdict between 0 and 5),

	-- Its own control, independent of the verdict, and not a seventh step on it.
	-- It can sit on any rung, including a low one: love, not likelihood.
	hearted       boolean     not null default false,

	-- "I'd been here before" — the film log's rewatch arrow.
	revisit       boolean     not null default false,

	friends       text[]      not null default '{}',
	review        text,
	tags          text[]      not null default '{}',

	created_at    timestamptz not null default now(),
	updated_at    timestamptz not null default now(),
	-- Soft delete, as in the film log: a deleted visit stops counting everywhere
	-- rather than taking its photos down with it.
	deleted_at    timestamptz
);

comment on column public.restaurant_visits.verdict is
	'Return verdict as an ordinal rank, 0 = Definitely return … 5 = Avoid. Belongs to the visit and moves between visits; a place''s headline verdict is its LATEST, never a max or a mean.';
comment on column public.restaurant_visits.hearted is
	'Independent of verdict. Love, not likelihood.';

create index if not exists restaurant_visits_visited_idx
	on public.restaurant_visits (visited_on desc, id desc)
	where deleted_at is null;
create index if not exists restaurant_visits_place_idx
	on public.restaurant_visits (restaurant_id, visited_on desc)
	where deleted_at is null;
create index if not exists restaurant_visits_tags_idx    on public.restaurant_visits using gin (tags);
create index if not exists restaurant_visits_friends_idx on public.restaurant_visits using gin (friends);

-- ---------------------------------------------------------------------------
-- restaurant_photos — my own photographs, the only picture this section gets
-- ---------------------------------------------------------------------------
-- A restaurant has no canonical image the way a film has a poster, so these are
-- the whole photographic supply and there are frequently none of them. Sizes
-- are recorded because the entries mix phone portraits with landscape shots and
-- a grid that assumes 4:3 will be wrong most of the time.
create table if not exists public.restaurant_photos (
	id           bigint generated always as identity primary key,
	visit_id     bigint      not null references public.restaurant_visits (id) on delete cascade,

	-- Object path inside the `restaurant-photos` storage bucket, e.g.
	-- "12/2026-08-08-a3f9.jpg". Not a URL: the public URL is derived from the
	-- project's storage host at render time so the rows survive a project move.
	storage_path text        not null unique,

	-- Usually absent. A caption is the exception, so nothing reserves room for one.
	caption      text,

	width        integer     check (width is null or width > 0),
	height       integer     check (height is null or height > 0),

	-- Order within the visit, as arranged in the composer.
	position     integer     not null default 0,
	created_at   timestamptz not null default now()
);

create index if not exists restaurant_photos_visit_idx
	on public.restaurant_photos (visit_id, position, id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Public like the film log, not private like the reading sessions: this section
-- is something to show people. Everyone reads, only the service-role key writes
-- (the API routes check the owner session first).
alter table public.restaurants        enable row level security;
alter table public.restaurant_visits  enable row level security;
alter table public.restaurant_photos  enable row level security;

drop policy if exists "public read restaurants"       on public.restaurants;
drop policy if exists "public read restaurant_visits" on public.restaurant_visits;
drop policy if exists "public read restaurant_photos" on public.restaurant_photos;

create policy "public read restaurants"       on public.restaurants       for select using (true);
create policy "public read restaurant_visits" on public.restaurant_visits for select using (true);
create policy "public read restaurant_photos" on public.restaurant_photos for select using (true);

-- ---------------------------------------------------------------------------
-- Photo storage
-- ---------------------------------------------------------------------------
-- Public bucket: the photos are rendered on public pages, so a signed URL per
-- image would buy nothing and cost a round trip each. Writes still go through
-- the service-role key.
insert into storage.buckets (id, name, public)
values ('restaurant-photos', 'restaurant-photos', true)
on conflict (id) do update set public = true;

-- ---------------------------------------------------------------------------
-- restaurant_places — the place with its visit history folded in
-- ---------------------------------------------------------------------------
-- Everything the list view, the map and the tiles need in one row, so the
-- common reads are one query rather than a join the app assembles by hand.
--
-- security_invoker so the view inherits the RLS above rather than running with
-- the definer's rights.
create or replace view public.restaurant_places
with (security_invoker = true) as
with visits as (
	select
		v.restaurant_id,
		count(*)                                            as visit_count,
		min(v.visited_on)                                   as first_visit,
		max(v.visited_on)                                   as last_visit,
		avg(v.rating)                                       as avg_rating,
		bool_or(v.hearted)                                  as hearted,
		-- The LATEST verdict, not the best or the average one. distinct on with
		-- an explicit order is the cheapest way to say "the one from the most
		-- recent visit that recorded one" without a second scan.
		count(*) filter (where v.rating is not null)        as rated_count
	from public.restaurant_visits v
	where v.deleted_at is null
	group by v.restaurant_id
),
latest as (
	select distinct on (v.restaurant_id)
		v.restaurant_id,
		v.verdict     as latest_verdict,
		v.visited_on  as latest_verdict_on
	from public.restaurant_visits v
	where v.deleted_at is null and v.verdict is not null
	order by v.restaurant_id, v.visited_on desc, v.id desc
),
cover as (
	-- One photograph to stand in for the place: the most recent one taken there.
	select distinct on (v.restaurant_id)
		v.restaurant_id,
		p.storage_path as cover_path,
		p.width        as cover_width,
		p.height       as cover_height
	from public.restaurant_photos p
	join public.restaurant_visits v on v.id = p.visit_id
	where v.deleted_at is null
	order by v.restaurant_id, v.visited_on desc, p.position, p.id
),
photo_totals as (
	select v.restaurant_id, count(p.id) as photo_count
	from public.restaurant_photos p
	join public.restaurant_visits v on v.id = p.visit_id
	where v.deleted_at is null
	group by v.restaurant_id
)
select
	r.*,
	coalesce(vs.visit_count, 0)  as visit_count,
	vs.first_visit,
	vs.last_visit,
	round(vs.avg_rating, 2)      as avg_rating,
	coalesce(vs.rated_count, 0)  as rated_count,
	coalesce(vs.hearted, false)  as hearted,
	l.latest_verdict,
	l.latest_verdict_on,
	c.cover_path,
	c.cover_width,
	c.cover_height,
	coalesce(pt.photo_count, 0)  as photo_count,
	-- The to-try list is "marked, and not yet been". Visiting a place takes it
	-- off the list without anything having to remember to.
	(r.to_try_added_at is not null and coalesce(vs.visit_count, 0) = 0) as on_to_try
from public.restaurants r
left join visits       vs on vs.restaurant_id = r.id
left join latest       l  on l.restaurant_id  = r.id
left join cover        c  on c.restaurant_id  = r.id
left join photo_totals pt on pt.restaurant_id = r.id;

-- ---------------------------------------------------------------------------
-- restaurant_diary — visits with their place, ready for the diary
-- ---------------------------------------------------------------------------
create or replace view public.restaurant_diary
with (security_invoker = true) as
select
	v.id,
	v.restaurant_id,
	v.visited_on,
	v.rating,
	v.verdict,
	v.hearted,
	v.revisit,
	v.friends,
	v.review,
	v.tags,
	v.created_at,
	v.updated_at,
	r.name          as restaurant_name,
	r.cuisines,
	r.price_band,
	r.neighborhood,
	r.city,
	r.state_region,
	r.country,
	coalesce(p.photo_count, 0) as photo_count
from public.restaurant_visits v
join public.restaurants r on r.id = v.restaurant_id
left join (
	select visit_id, count(*) as photo_count
	from public.restaurant_photos
	group by visit_id
) p on p.visit_id = v.id
where v.deleted_at is null;

grant select on public.restaurant_places to anon, authenticated;
grant select on public.restaurant_diary  to anon, authenticated;
