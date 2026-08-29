-- Drop the per-section "favorites" feature. It is replaced by cross-section
-- pinned journal entries (journal_pins, migration 0047), so the three
-- favourite columns and everything hanging off them come out here.
--
-- APPLY THIS ONLY AFTER the code that stops reading these columns is deployed.
-- The columns are additive-safe to keep around, so the new code runs fine while
-- they still exist; dropping them before the new code is live would break the
-- old code's favourites queries. Order: deploy, then apply.
--
-- Two of the three columns are exposed through a view, and a view built with
-- `select r.*` / an explicit column list depends on the column by name — so the
-- column can't be dropped until the view is rebuilt without it. Each section
-- below drops/rebuilds its view around the column drop.

-- ---------------------------------------------------------------------------
-- Films: watched.favorite (0006) + watched.favorite_rank (0007).
-- No view exposes these — they were queried off `watched` directly — so this is
-- just the trigger, its function, the partial index (dropped with the column),
-- and the two columns.
-- ---------------------------------------------------------------------------
drop trigger if exists watched_max_favorites on public.watched;
drop function if exists public.enforce_max_favorites();
alter table public.watched drop column if exists favorite_rank;
alter table public.watched drop column if exists favorite;

-- ---------------------------------------------------------------------------
-- Restaurants: restaurants.favorite_rank (0030). Exposed through
-- restaurant_places via `select r.*`, so the view is dropped, the column
-- removed (its partial unique index goes with it), and the view rebuilt
-- verbatim from migration 0033 — `r.*` now simply no longer includes it.
-- restaurant_diary does not reference the column and is left alone.
-- ---------------------------------------------------------------------------
drop view if exists public.restaurant_places;
alter table public.restaurants drop column if exists favorite_rank;

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

grant select on public.restaurant_places to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activities: activities.favorite_rank (0034). Exposed through activity_list
-- with an explicit `a.favorite_rank` line, so the view is dropped and rebuilt
-- verbatim from migration 0044 minus that one line, then the column (and its
-- partial unique index) is dropped.
-- ---------------------------------------------------------------------------
drop view if exists public.activity_list;

create view public.activity_list
with (security_invoker = true) as
select
	a.id,
	a.sport,
	a.sub_sport,
	a.parent_id,
	a.leg,
	a.title,
	a.notes,
	a.started_at,
	a.local_date,
	a.utc_offset_minutes,
	a.timezone,
	a.elapsed_seconds,
	a.moving_seconds,
	a.distance_m,
	a.elevation_gain_m,
	a.elevation_loss_m,
	a.elev_high_m,
	a.elev_low_m,
	a.avg_speed_ms,
	a.max_speed_ms,
	a.avg_hr,
	a.max_hr,
	a.avg_cadence,
	a.avg_power_w,
	a.max_power_w,
	a.normalized_power_w,
	a.work_kj,
	a.calories,
	a.avg_temp_c,
	a.pool_length_m,
	a.total_strokes,
	a.avg_swolf,
	a.exertion,
	a.exertion_method,
	a.exertion_confidence,
	a.intensity_factor,
	a.polyline,
	a.route_path,
	a.start_lat,
	a.start_lng,
	a.end_lat,
	a.end_lng,
	a.bbox_w,
	a.bbox_s,
	a.bbox_e,
	a.bbox_n,
	a.start_place,
	a.gear_id,
	g.name          as gear_name,
	g.nickname      as gear_nickname,
	a.has_streams,
	a.device_name,
	a.created_at,
	a.updated_at,
	s.provider      as source_provider,
	a.private,
	a.hide_from_review
from public.activities a
left join public.activity_gear g on g.id = a.gear_id
left join lateral (
	select provider
	from public.activity_sources
	where activity_id = a.id
	order by fidelity desc, imported_at desc
	limit 1
) s on true
where a.deleted_at is null;

grant select on public.activity_list to anon, authenticated;

alter table public.activities drop column if exists favorite_rank;
