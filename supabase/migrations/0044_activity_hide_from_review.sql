-- Two owner controls the activity editor was missing: a way to keep an
-- activity out of the month in review, and a way to delete one.
--
-- `hide_from_review` is a presentation choice, not a privacy one. /month is
-- already owner-only, so nothing here is load-bearing for disclosure — it
-- exists because a month's calendar is a composed page and some activities are
-- noise on it (the third dog walk of the week, a duplicate the importer left
-- behind). Hence `default false`: hiding is opt-in, and every existing row
-- keeps showing. That is the opposite of 0043's default, and deliberately so —
-- getting this one wrong shows a walk on a page only its owner can open.
alter table public.activities
	add column if not exists hide_from_review boolean not null default false;

comment on column public.activities.hide_from_review is
	'Owner''s choice to keep this activity off /month (the generic month in review). Presentation only, not privacy — /month is owner-gated regardless, and this column has no effect on /activities or any public surface. Read in src/pages/month/[month].astro.';

-- No index. Unlike `private` this is never a filter over the whole table —
-- it's applied to the ~30 rows of a single month that are already in memory.

-- ---------------------------------------------------------------------------
-- Deletion is soft. Every read in src/lib/activities.ts already carries
-- `.is('deleted_at', null)`, and activity_list filters on it too, so setting
-- the timestamp is a complete delete as far as the site is concerned — while
-- leaving the FIT/GPX-derived streams recoverable, which a DELETE would not.
-- The column already exists; this is only a note that it now has a caller.
-- ---------------------------------------------------------------------------

-- activity_list gains the new column, appended last so `create or replace
-- view` accepts it (Postgres only allows new columns at the end).
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
