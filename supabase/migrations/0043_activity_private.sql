-- Activities are private by default.
--
-- The activity log carried more about a person than the other three sections
-- put together: where they live (a route that starts at the front door, drawn
-- on every card), when they are out of the house, and how fit they are. All of
-- it was world-readable. This adds the switch that was missing and sets it the
-- only way a switch like this can safely default: closed.
--
--   private = true  — owner-only. The activity exists in the day grid as a
--                     sport icon and nothing else; its detail page 404s for
--                     anyone else. This is the DEFAULT, and it is applied to
--                     every row already in the table.
--   private = false — public. The full card, the route, the detail page.
--
-- `not null default true` backfills every existing row to true in one pass,
-- which is the point: the fix is worthless if it only covers activities
-- imported after it.
alter table public.activities
	add column if not exists private boolean not null default true;

comment on column public.activities.private is
	'Owner-only when true, which is the default for every activity including every row that existed before this migration. A visitor sees a private activity as a bare sport icon in the day grid and gets a 404 at its detail page. Redaction is enforced in src/lib/activities.ts (redactActivities) — this column is what it reads.';

create index if not exists activities_private_idx
	on public.activities (private)
	where deleted_at is null;

-- ---------------------------------------------------------------------------
-- activity_list gains the column. Appended last, so `create or replace view`
-- accepts it (Postgres only allows new columns at the end of an existing
-- view's select list).
-- ---------------------------------------------------------------------------
create or replace view public.activity_list
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
	a.favorite_rank,
	a.has_streams,
	a.device_name,
	a.created_at,
	a.updated_at,
	s.provider      as source_provider,
	a.private
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
