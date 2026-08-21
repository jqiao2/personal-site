-- The activity log: the fourth section of the family, and the first whose
-- records are ingested from machines rather than typed by hand.
--
-- The film log models a relationship to a MOVIE, the book log to a BOOK, the
-- restaurant log to a PLACE YOU EAT. This one models A THING THE BODY DID, and
-- that difference decides the shape:
--
--   - The record is not authored, it is ingested. A provenance layer
--     (`activity_sources`) tracks which device, which file, which external id
--     produced a row — the siblings don't need this because a diary entry has
--     no "device" to disagree about.
--   - The same ride can arrive three times (Wahoo, then Strava, then Garmin
--     Connect). `activity_sources` is where the losers of a dedupe pass are
--     recorded so the link back to the origin survives even though the row
--     itself doesn't duplicate.
--   - Not every activity has a route. A pool swim, a trainer ride and a
--     treadmill run have no GPS at all — `polyline`/`route_path`/lat-lng
--     columns are all nullable and null is a normal reading, not a gap.
--   - Activities aren't comparable by any one number. `exertion` is this
--     section's one comparable axis (see src/lib/exertion.ts), computed by the
--     best method the activity's data supports — `exertion_method` and
--     `exertion_confidence` travel with it so the UI never shows a number
--     without a way to see how it was got.
--
-- See ACTIVITIES.md §5 for the full design contract this migration implements.
--
-- Run with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- activity_gear — bikes, shoes, skis. Referenced by activities, so it comes first.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_gear (
	id          bigint generated always as identity primary key,
	kind        text        not null check (kind in ('bike', 'shoes', 'skis', 'board', 'other')),
	name        text        not null,
	brand       text,
	model       text,
	-- What's actually said in the UI ("the gravel bike") when it differs from
	-- the catalog name ("2023 Salsa Cutthroat").
	nickname    text,
	retired_at  timestamptz,
	-- Denormalised running total (kept in sync by the app on write, not a
	-- trigger — gear totals aren't consistency-critical and a trigger on every
	-- activity insert would be a lot of machinery for a sidebar stat).
	distance_m  double precision not null default 0,
	-- Provider ids for this piece of gear (Strava's gear id, Garmin's, …), so an
	-- import can resolve "which bike" without asking again.
	external_ids jsonb      not null default '{}',
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now()
);

comment on column public.activity_gear.nickname is
	'What''s said in the UI when it differs from the catalog name — "the gravel bike" vs "2023 Salsa Cutthroat".';
comment on column public.activity_gear.distance_m is
	'Denormalised running total, kept in sync on write. Not FK-derived: a retired bike''s total shouldn''t change because an old ride got re-tagged.';

create index if not exists activity_gear_kind_idx on public.activity_gear (kind);

-- ---------------------------------------------------------------------------
-- athlete_thresholds — FTP/LTHR/etc over time, for the exertion calculator
-- ---------------------------------------------------------------------------
-- Thresholds change over time (FTP in March is not FTp in September), so this
-- is versioned by effective date rather than a single row of "current" values.
-- Exactly one row is "in force" on a given day: the latest effective_from <=
-- that day. Pure lookup table — src/lib/exertion.ts is handed the row in
-- force for an activity's date and does the math; nothing here computes
-- anything.
create table if not exists public.athlete_thresholds (
	id                       bigint generated always as identity primary key,
	effective_from           date not null,
	ftp_w                    smallint,
	lthr_bpm                 smallint,
	max_hr                   smallint,
	rest_hr                  smallint,
	-- Running threshold pace, seconds per km. Stored as a rate rather than a
	-- "threshold speed" because every consumer (rTSS, grade-adjusted pace)
	-- wants pace, not speed.
	threshold_pace_s_per_km  double precision,
	-- Swimming: critical swim speed pace, seconds per 100m — the pool's native unit.
	css_pace_s_per_100m      double precision,
	weight_kg                double precision,
	created_at               timestamptz not null default now()
);

comment on column public.athlete_thresholds.effective_from is
	'Versioning key, not a range: the row in force on a date is the latest one with effective_from <= that date. No effective_to — the next row''s effective_from is where this one stops applying.';

create unique index if not exists athlete_thresholds_effective_from_key
	on public.athlete_thresholds (effective_from);
create index if not exists athlete_thresholds_effective_from_idx
	on public.athlete_thresholds (effective_from desc);

-- ---------------------------------------------------------------------------
-- activities — the record. One row per activity; a multisport activity is a
-- parent with children (see parent_id).
-- ---------------------------------------------------------------------------
create table if not exists public.activities (
	id                 bigint generated always as identity primary key,

	-- Canonical slug, see src/lib/sports.ts (ACTIVITIES.md §6) for the full list
	-- and the label/icon/primaryStats table it drives.
	sport              text        not null,
	-- 'gravel', 'indoor', 'open_water', 'resort'… — a free second axis rather
	-- than exploding `sport` combinatorially; most sports never set it.
	sub_sport          text,

	-- A triathlon (etc) is one parent row with child legs. Cascade: deleting
	-- the parent day takes its legs with it, because a leg doesn't exist
	-- without the day it was part of.
	parent_id          bigint      references public.activities (id) on delete cascade,
	-- Order within a multisport parent: 1 = swim, 2 = T1, 3 = bike, 4 = T2, 5 = run…
	leg                smallint,

	title              text        not null,
	notes              text,
	-- Never rendered publicly — the owner's private training notes.
	private_notes      text,

	started_at         timestamptz not null,
	-- The calendar day WHERE IT HAPPENED, not the day UTC would compute. The
	-- week grid and activity_days key off this, not started_at, because a
	-- 11pm-local ride must not land on tomorrow's UTC date.
	local_date         date        not null,
	utc_offset_minutes smallint,
	timezone           text,

	elapsed_seconds    integer     not null,
	-- Null until computed; distinct from elapsed_seconds because a two-hour
	-- café stop mid-ride is elapsed time that must never count as exertion.
	moving_seconds     integer,
	distance_m         double precision,
	elevation_gain_m   double precision,
	elevation_loss_m   double precision,
	elev_high_m        double precision,
	elev_low_m         double precision,

	avg_speed_ms       double precision,
	max_speed_ms       double precision,
	avg_hr             smallint,
	max_hr             smallint,
	avg_cadence        smallint,
	avg_power_w        smallint,
	max_power_w        smallint,
	normalized_power_w smallint,
	work_kj            double precision,
	calories           integer,
	avg_temp_c         double precision,

	-- Swimming only.
	pool_length_m      double precision,
	total_strokes      integer,
	avg_swolf          smallint,

	-- The one comparable axis across every sport. See ACTIVITIES.md §3 and
	-- src/lib/exertion.ts (pure functions over streams — no DB access, so the
	-- whole table can be recomputed when a threshold changes).
	exertion            double precision,
	exertion_method     text        check (exertion_method is null or exertion_method in ('tss', 'hrtss', 'avghr', 'ptss', 'met')),
	exertion_confidence text        check (exertion_confidence is null or exertion_confidence in ('measured', 'estimated', 'assumed')),
	intensity_factor    double precision,

	-- Geometry, for the poster and the map. Both nullable together: an activity
	-- with no GPS (trainer, treadmill, pool) sets neither, and that's a normal
	-- reading, not a gap — see ACTIVITIES.md §7.
	polyline           text,
	route_path         text,
	start_lat          double precision check (start_lat is null or start_lat between -90 and 90),
	start_lng          double precision check (start_lng is null or start_lng between -180 and 180),
	end_lat            double precision check (end_lat is null or end_lat between -90 and 90),
	end_lng            double precision check (end_lng is null or end_lng between -180 and 180),
	bbox_w             double precision,
	bbox_s             double precision,
	bbox_e             double precision,
	bbox_n             double precision,
	-- Reverse geocoded, e.g. "Snoqualmie Pass, WA". Nullable — an activity with
	-- no GPS has no start place, and one with GPS may not have been geocoded yet.
	start_place        text,

	gear_id            bigint      references public.activity_gear (id) on delete set null,

	-- The landing page's hand-picked top four, same convention as the film log's
	-- watched.favorite and the restaurant log's restaurants.favorite_rank.
	favorite_rank      smallint    check (favorite_rank is null or favorite_rank between 1 and 4),
	-- Denormalised rather than "select exists(...) from activity_streams": the
	-- list view reads this column and never touches activity_streams at all —
	-- streams are big and only the detail page pays for them.
	has_streams        boolean     not null default false,
	device_name        text,

	created_at         timestamptz not null default now(),
	updated_at         timestamptz not null default now(),
	-- Soft delete, as in the film log and restaurant log: a deleted activity
	-- stops counting everywhere rather than taking its streams/laps down with it
	-- immediately (the FK cascade still applies on a hard delete).
	deleted_at         timestamptz
);

comment on column public.activities.local_date is
	'The calendar day WHERE IT HAPPENED, derived from started_at + utc_offset_minutes at ingest time. The week grid and activity_days key off this, not started_at — a late-night ride must land on the day it was ridden, not the UTC day it crossed into.';
comment on column public.activities.parent_id is
	'Set for a multisport leg (triathlon swim/T1/bike/T2/run); null for a standalone activity. Cascades on delete: a leg has no existence apart from its parent day.';
comment on column public.activities.leg is
	'Order within a multisport parent: 1 = swim, 2 = T1, 3 = bike, 4 = T2, 5 = run, etc. Null on a standalone activity and on the parent row itself.';
comment on column public.activities.exertion_method is
	'Which of the exertion cascade (ACTIVITIES.md §3) produced the number: tss (power) > hrtss (HR) > avghr (flat HR) > ptss (pace) > met (floor). Must always travel with exertion — a number with no method is not trustworthy.';
comment on column public.activities.exertion_confidence is
	'measured (real sensor stream), estimated (derived from a stream via a model), or assumed (no stream, MET-table floor). The UI must show this alongside exertion, never the number alone.';
comment on column public.activities.route_path is
	'Normalised SVG path, viewBox 0 0 100 100, RDP-simplified to <=200 points — see ACTIVITIES.md §7 and src/lib/route-shape.ts. Null for anything with no GPS; that''s a deliberate second card design, not a broken first one.';
comment on column public.activities.has_streams is
	'Denormalised from activity_streams so the list view never has to join the (large) streams table just to know whether a route/graph can be drawn.';

-- Partial unique: at most one activity per rank, any number at no rank.
create unique index if not exists activities_favorite_rank_key
	on public.activities (favorite_rank)
	where favorite_rank is not null and deleted_at is null;

create index if not exists activities_local_date_idx on public.activities (local_date desc) where deleted_at is null;
create index if not exists activities_sport_idx       on public.activities (sport)          where deleted_at is null;
create index if not exists activities_exertion_idx    on public.activities (exertion desc)  where deleted_at is null;
create index if not exists activities_started_at_idx  on public.activities (started_at)     where deleted_at is null;
create index if not exists activities_parent_id_idx   on public.activities (parent_id)      where parent_id is not null;
create index if not exists activities_gear_id_idx     on public.activities (gear_id)        where gear_id is not null;

-- ---------------------------------------------------------------------------
-- activity_streams — one row per activity. Big, and only read on the detail
-- page, so they never join the list queries (that's what activity_list is for).
-- ---------------------------------------------------------------------------
create table if not exists public.activity_streams (
	activity_id  bigint      primary key references public.activities (id) on delete cascade,
	sample_count integer     not null,
	time_s       jsonb,   -- int[] seconds from start
	latlng       jsonb,   -- [[lat,lng], …]
	altitude_m   jsonb,
	distance_m   jsonb,
	heartrate    jsonb,
	cadence      jsonb,
	power_w      jsonb,
	speed_ms     jsonb,
	temp_c       jsonb,
	grade        jsonb,
	moving       jsonb    -- bool[]
);

comment on table public.activity_streams is
	'One row per activity, keyed 1:1 on activity_id (not its own identity column — there is never more than one stream set per activity). Deliberately excluded from activity_list: these arrays can run to thousands of samples and the list/landing pages never need them.';

-- ---------------------------------------------------------------------------
-- activity_laps
-- ---------------------------------------------------------------------------
create table if not exists public.activity_laps (
	id               bigint      generated always as identity primary key,
	activity_id      bigint      not null references public.activities (id) on delete cascade,
	lap_index        integer     not null,
	name             text,
	start_time       timestamptz,
	elapsed_seconds  integer,
	moving_seconds   integer,
	distance_m       double precision,
	avg_hr           smallint,
	max_hr           smallint,
	avg_power_w      smallint,
	avg_speed_ms     double precision,
	elevation_gain_m double precision,
	lap_type         text        not null default 'lap'
		check (lap_type in ('lap', 'interval', 'rest', 'transition', 'length'))
);

comment on column public.activity_laps.lap_type is
	'A triathlon transition is BOTH a lap of type transition on the parent AND its own child activity (sport = ''transition''): one to look at on its own, one as a marker inside the whole day''s effort.';

create unique index if not exists activity_laps_activity_index_key
	on public.activity_laps (activity_id, lap_index);
create index if not exists activity_laps_activity_idx on public.activity_laps (activity_id);

-- ---------------------------------------------------------------------------
-- activity_sources — provenance, and the dedupe survivors
-- ---------------------------------------------------------------------------
-- See ACTIVITIES.md §4: two rows can be the same activity arriving from three
-- providers, and the loser of a dedupe pass is recorded here (not deleted) so
-- the link back to e.g. Strava survives even though only the winning row's
-- data is kept live on `activities`.
create table if not exists public.activity_sources (
	id              bigint      generated always as identity primary key,
	activity_id     bigint      not null references public.activities (id) on delete cascade,
	provider        text        not null check (provider in
		('strava_archive', 'strava_api', 'garmin', 'wahoo', 'trainerroad', 'file', 'manual')),
	external_id     text,
	external_url    text,
	file_name       text,
	-- sha256, so re-importing the same export file is a no-op rather than a duplicate.
	file_checksum   text,
	-- Higher wins a dedupe: recorded-by-device beats mirrored-from-Strava.
	fidelity        smallint    not null default 0,
	-- What the provider said, verbatim — the audit trail for a parse that turns
	-- out to be wrong.
	raw             jsonb,
	imported_at     timestamptz not null default now()
);

comment on column public.activity_sources.provider is
	'strava_archive (the owner''s own data export — unencumbered by the API terms) is distinct from strava_api (OAuth sync, must carry "Powered by Strava" attribution) so the two paths stay checkable. See ACTIVITIES.md §4.';
comment on column public.activity_sources.fidelity is
	'Higher wins a dedupe match: a file recorded by the originating device outranks the same ride mirrored through Strava. The loser stays in this table (not deleted) so the external link survives.';
comment on column public.activity_sources.file_checksum is
	'sha256 of the imported file. Unique where not null, so re-running an import over the same export is a no-op rather than a duplicate row.';

create unique index if not exists activity_sources_provider_external_key
	on public.activity_sources (provider, external_id)
	where external_id is not null;
create unique index if not exists activity_sources_file_checksum_key
	on public.activity_sources (file_checksum)
	where file_checksum is not null;
create index if not exists activity_sources_activity_idx on public.activity_sources (activity_id);

-- ---------------------------------------------------------------------------
-- Row-level security — public like the film/restaurant logs: everyone reads,
-- only the service-role key writes (API routes check requireOwner() first).
-- ---------------------------------------------------------------------------
alter table public.activities          enable row level security;
alter table public.activity_streams    enable row level security;
alter table public.activity_laps       enable row level security;
alter table public.activity_gear       enable row level security;
alter table public.activity_sources    enable row level security;
alter table public.athlete_thresholds  enable row level security;

drop policy if exists "public read activities"         on public.activities;
drop policy if exists "public read activity_streams"   on public.activity_streams;
drop policy if exists "public read activity_laps"      on public.activity_laps;
drop policy if exists "public read activity_gear"      on public.activity_gear;
drop policy if exists "public read activity_sources"   on public.activity_sources;
drop policy if exists "public read athlete_thresholds" on public.athlete_thresholds;

create policy "public read activities"         on public.activities         for select using (true);
create policy "public read activity_streams"   on public.activity_streams   for select using (true);
create policy "public read activity_laps"      on public.activity_laps      for select using (true);
create policy "public read activity_gear"      on public.activity_gear      for select using (true);
create policy "public read activity_sources"   on public.activity_sources   for select using (true);
create policy "public read athlete_thresholds" on public.athlete_thresholds for select using (true);

-- ---------------------------------------------------------------------------
-- activity_list — everything the list/landing pages need and nothing they
-- don't (no streams, no raw). Joins gear name and the winning source's provider.
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
	-- The winning (highest-fidelity) source's provider, for a "via Strava" style
	-- credit line. An activity can carry several source rows (the dedupe
	-- losers); this is deliberately just one so the list query stays a plain join.
	s.provider      as source_provider
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

-- ---------------------------------------------------------------------------
-- activity_days — one row per local_date with counts/totals. What the week
-- grid reads.
-- ---------------------------------------------------------------------------
create or replace view public.activity_days
with (security_invoker = true) as
select
	local_date,
	count(*)                                    as activity_count,
	coalesce(sum(distance_m), 0)                as total_distance_m,
	coalesce(sum(elevation_gain_m), 0)          as total_elevation_gain_m,
	coalesce(sum(moving_seconds), 0)            as total_moving_seconds,
	coalesce(sum(exertion), 0)                  as total_exertion,
	array_agg(distinct sport order by sport)    as sports
from public.activities
where deleted_at is null
	-- A triathlon's legs would otherwise triple-count the day's distance/time
	-- alongside the parent; the parent row already carries the whole-day totals.
	and parent_id is null
group by local_date;

comment on view public.activity_days is
'One row per calendar day with the day''s activities rolled up. Multisport legs (parent_id is not null) are excluded from the sums — the parent row already carries the combined totals — so a triathlon day is not triple-counted.';

-- ---------------------------------------------------------------------------
-- activity_months — per-month rollups for the month-in-review header.
-- ---------------------------------------------------------------------------
create or replace view public.activity_months
with (security_invoker = true) as
select
	to_char(local_date, 'YYYY-MM')              as month_key,
	count(*)                                    as activity_count,
	coalesce(sum(distance_m), 0)                as total_distance_m,
	coalesce(sum(elevation_gain_m), 0)          as total_elevation_gain_m,
	coalesce(sum(moving_seconds), 0)            as total_moving_seconds,
	coalesce(sum(exertion), 0)                  as total_exertion,
	array_agg(distinct sport order by sport)    as sports
from public.activities
where deleted_at is null
	and parent_id is null
group by to_char(local_date, 'YYYY-MM');

comment on view public.activity_months is
'Per-month rollups for the /activities/month index and share card, same family as the film log''s monthly views. Multisport legs excluded from the sums for the same reason as activity_days.';

grant select on public.activity_list    to anon, authenticated;
grant select on public.activity_days    to anon, authenticated;
grant select on public.activity_months  to anon, authenticated;
