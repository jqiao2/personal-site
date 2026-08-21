-- RECOVERED FROM THE APPLIED HISTORY, NOT AUTHORED HERE.
--
-- This migration was applied to the database without a file — the exact failure
-- CLAUDE.md warns about. The SQL below is the verbatim contents of
-- `supabase_migrations.schema_migrations.statements` for version 0033,
-- reconstructed so the repo can rebuild the database and so 0033 can never be
-- silently reused by a later file. Do not edit it: the version is already
-- recorded as applied, so `db push` will never read this file again. Anything
-- that needs changing here needs a new numbered migration.

alter table public.restaurants
	add column if not exists osm_type     text,
	add column if not exists osm_id       bigint,
	add column if not exists place_rank   smallint,
	add column if not exists house_number text,
	add column if not exists road         text,
	add column if not exists quarter      text,
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

create unique index if not exists restaurants_osm_object_key
	on public.restaurants (osm_type, osm_id)
	where osm_id is not null;

create index if not exists restaurants_borough_idx
	on public.restaurants (borough)
	where borough is not null;

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
	(r.to_try_added_at is not null and coalesce(vs.visit_count, 0) = 0) as on_to_try
from public.restaurants r
left join visits       vs on vs.restaurant_id = r.id
left join latest       l  on l.restaurant_id  = r.id
left join cover        c  on c.restaurant_id  = r.id
left join photo_totals pt on pt.restaurant_id = r.id;

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
