-- Take the GPS track back out of activity_list.
--
-- The view's contract, written at the top of ActivityListRow, is "everything
-- the list/landing pages need and nothing they don't (no streams, no raw
-- source payloads)". `polyline` breaks that promise and is by far the most
-- expensive way it could: measured over 25 rows, activity_list averages 5,386
-- bytes a row and `polyline` alone is 3,883 of them — 72%.
--
-- Four reads do `select('*')` on this view (listActivities, listActivityDays,
-- listActivityChildren, listActivitiesForMonth, plus pins.ts), and not one of
-- them looks at `polyline`. There are exactly two readers of that column in the
-- whole site and neither goes through here:
--
--   /activities/[id]     getActivity(), which reads the `activities` table
--                        directly via PUBLIC_ACTIVITY_COLUMNS.
--   /activities/heatmap  listRoutePolylines(), which names its columns.
--
-- So every home page, every /month, and every RSS poll has been pulling every
-- route's full-fidelity GPS track across the wire to render a feed that shows a
-- title and a date. `/rss.xml` spends 299 KB of Supabase egress to emit a 9 KB
-- feed, and this column is most of the difference. That is what ran the project
-- past its 5 GB egress allowance.
--
-- The thumbnail squiggle the month feed *does* draw comes from `route_path`
-- (967 bytes a row), which stays.
--
-- WHY DROP AND REBUILD rather than `create or replace`. Replacing a view cannot
-- change its column list — Postgres rejects it (see wiki pattern 0003). So the
-- view is dropped and recreated verbatim from migration 0048 minus the one
-- `a.polyline` line, which is exactly the move 0048 itself made to shed
-- `favorite_rank`.
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
