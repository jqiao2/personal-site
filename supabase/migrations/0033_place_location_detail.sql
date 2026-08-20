-- Where a place is, at the granularity OSM actually answers in.
--
-- The log has had five location fields since 0030 — neighborhood, city,
-- state_region, country and a point — and they were the right five to start
-- with. Four things were missing, and three of them were missing in a way that
-- is worth being precise about, because OSM was ALREADY RETURNING THEM and the
-- code was throwing them away:
--
--   THE STREET. `geocode.ts` builds "83 Elizabeth Street, Chinatown, New York"
--   so the picker can tell two hits apart, and then discards it the moment you
--   pick one. The address is the one location fact a coordinate cannot
--   reconstruct and a human cannot eyeball, and the log did not keep it.
--
--   THE QUARTER AND THE BOROUGH. `toHit()` collapsed three tiers into one
--   column — `neighbourhood ?? suburb ?? quarter` — so a quarter arrived as a
--   neighbourhood and could not be told back apart. The borough was worse than
--   flattened: Nominatim returns NYC boroughs as `city_district`, which nothing
--   read, while `a.city` for anywhere in the five boroughs is "New York". So
--   Brooklyn either leaked in through `suburb` or vanished, and there was no
--   way to ask a list for Brooklyn.
--
--   OSM'S OWN IDENTITY. `osm_type`/`osm_id` never even reached the type
--   boundary. Without them a coordinate on a row is an assertion with no
--   provenance: you cannot re-query the object, notice it moved or closed, or
--   carry the attribution ODbL asks for.
--
-- ALL SEVEN ARE NULLABLE, and that is not defensive hedging. Every one of them
-- is legitimately absent somewhere: a cart has no house number, most of the
-- world has no borough, a quarter is rare outside Europe and Asia, and a place
-- pinned by plus code has no OSM object behind it at all. Null keeps meaning
-- "this level of detail does not apply here", exactly as `neighborhood` has
-- always meant it, rather than "a field is missing".
--
-- NO plus_code COLUMN. A plus code is a pure function of lat/lng and carries
-- nothing they do not. Storing it would be a second copy of the coordinates
-- that can disagree with the first, which is the only way it could ever be
-- wrong. It is derived on read instead — see `encode()` in plus-code.ts.
--
-- NO address TEXT COLUMN either. The rendered line is house_number and road
-- joined, and a stored copy of a join is a third thing to keep in sync.

alter table public.restaurants
	-- OSM's handle on the object: node/way/relation plus its id. Together they
	-- are the stable identity of the thing that was matched, and the difference
	-- between a geocode you can audit and a rumour.
	add column if not exists osm_type     text,
	add column if not exists osm_id       bigint,
	-- The number `precise` is computed from (>= 30 is an object at a point, not
	-- the centroid of an area). Kept so that judgement can be re-made later
	-- without re-fetching every place to find out.
	add column if not exists place_rank   smallint,

	-- The street, as two facts rather than one. They are used apart: the road
	-- alone is the useful half for a cart or a stall, and a number without a
	-- road means nothing.
	add column if not exists house_number text,
	add column if not exists road         text,

	-- Its own column, NOT a fallback for neighborhood. The whole reason the old
	-- ?? chain lost data is that it treated three tiers as interchangeable.
	add column if not exists quarter      text,
	-- Brooklyn, Queens, Manhattan… The expected OSM key is `city_district`, but
	-- what Nominatim actually returns for a New York address is
	-- { neighbourhood: "Sunset Park", suburb: "Brooklyn", city: "New York" } —
	-- so `suburb` carries it here while elsewhere it is the neighbourhood. See
	-- `splitAddress` in geocode.ts for the rule that reads both. Null nearly
	-- everywhere outside New York, which is correct: it is a tier some cities
	-- have, not a required one.
	add column if not exists borough      text;

alter table public.restaurants
	drop constraint if exists restaurants_osm_type_check;
alter table public.restaurants
	add constraint restaurants_osm_type_check
	check (osm_type is null or osm_type in ('node', 'way', 'relation'));

comment on column public.restaurants.osm_id is
	'OpenStreetMap object id, with osm_type. Provenance for the geocode: null means the point came from somewhere else (a plus code, a pasted pair, the DOHMH import) or from nowhere.';
comment on column public.restaurants.place_rank is
	'Nominatim''s granularity grade for the matched object. >= 30 is a point on a thing; below that is an area whose centroid must never be stored as a location.';
comment on column public.restaurants.borough is
	'The tier between neighbourhood and city. Brooklyn, not New York. Read from OSM''s `suburb` when a finer `neighbourhood` is also present, else `city_district`. Null nearly everywhere outside New York, and that is the right reading.';
comment on column public.restaurants.quarter is
	'OSM''s `quarter`: a subdivision below the neighbourhood. Its own field, never a fallback for neighborhood.';

-- One place per OSM object. Partial, because null is the common case and
-- several places sharing "no OSM object" is not a conflict.
create unique index if not exists restaurants_osm_object_key
	on public.restaurants (osm_type, osm_id)
	where osm_id is not null;

-- The borough is the unit New York is discussed in, so it is the unit lists
-- get grouped and filtered by. Partial for the same reason as above.
create index if not exists restaurants_borough_idx
	on public.restaurants (borough)
	where borough is not null;

-- ---------------------------------------------------------------------------
-- Rebuilding the two views
-- ---------------------------------------------------------------------------
-- restaurant_places selects `r.*`, which Postgres expanded ONCE, at creation,
-- into the column list as it stood. The seven new columns are invisible to it
-- until it is rebuilt, and `create or replace view` cannot do the rebuild:
-- replace may only APPEND columns at the end, while these land in the middle,
-- ahead of visit_count and everything the view computes. Same trap 0031 hit,
-- same way out. The grants are reissued because dropping takes them with it.

drop view if exists public.restaurant_places;

create view public.restaurant_places
with (security_invoker = true) as
with visits as (
	select
		v.restaurant_id,
		count(*)                                            as visit_count,
		min(v.visited_on)                                   as first_visit,
		max(v.visited_on)                                   as last_visit,
		avg(v.rating)                                       as avg_rating,
		bool_or(v.hearted)                                  as hearted,
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

-- restaurant_diary names its columns explicitly, so it only needs the one that
-- renders: a diary row says where it was, and in New York that line wants
-- "Sunset Park, Brooklyn" rather than "Sunset Park, New York". The street and
-- the OSM identity are place-detail, not diary-row, and are left off on
-- purpose. Dropped rather than replaced so `borough` sits beside the other
-- location words instead of trailing after photo_count.
drop view if exists public.restaurant_diary;

create view public.restaurant_diary
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
	r.borough,
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
