-- Two things the log had no way to say about a place, and one of them is the
-- only reason half the to-try list exists.
--
-- WORTH THE TRIP is not a rating and not a verdict. The verdict answers "would
-- I come back", which needs a visit to have happened; this answers "would I go
-- out of my way", which is the question a shortlist is actually sorted by and
-- which you can answer about somewhere you have never been. It belongs to the
-- PLACE rather than to a visit for that reason: a visit cannot carry it before
-- there is one, and unlike the verdict it does not move meal to meal.
--
-- TO_TRY_TAGS is the kind of why. `to_try_reason` is one line of prose and
-- stays the record — "Peking duck, BYOB, a big table" is not improved by being
-- a taxonomy — but prose cannot be filtered, and the list is long enough that
-- "the places someone recommended" and "the places I walked past" are
-- different lists. So the tags sit beside the sentence rather than replacing
-- it, from a small fixed vocabulary the app owns (see WHY_TAGS): a free tag
-- field would silt up with synonyms and filter nothing.
--
-- Named to_try_tags, not tags, because restaurant_visits.tags already exists
-- and means something else: what a MEAL was like. These are why you want to go.

alter table public.restaurants
	add column if not exists trip         boolean  not null default false,
	add column if not exists to_try_tags  text[]   not null default '{}';

comment on column public.restaurants.trip is
	'Would I go out of my way for it. A property of the place, answerable before any visit, and not a rung of the return verdict.';
comment on column public.restaurants.to_try_tags is
	'The kind of why, from the app''s fixed vocabulary. Beside to_try_reason, never instead of it.';

-- Partial: the interesting half is the true one, and it is the minority.
create index if not exists restaurants_trip_idx
	on public.restaurants (trip)
	where trip;

create index if not exists restaurants_to_try_tags_idx
	on public.restaurants using gin (to_try_tags);

-- ---------------------------------------------------------------------------
-- Rebuilding restaurant_places, which cannot see the new columns
-- ---------------------------------------------------------------------------
-- The view selects `r.*`, and Postgres expands that ONCE, at creation, into
-- the column list as it stood. New columns on the table are invisible to it
-- until it is rebuilt — and `create or replace view` cannot do the rebuild,
-- because replace may only append columns at the end while these two land in
-- the middle, ahead of visit_count and everything the view computes.
--
-- So it is dropped and recreated, identically but for the two columns arriving
-- inside `r.*`, and its grant is reissued because dropping took that with it.
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

grant select on public.restaurant_places to anon, authenticated;
