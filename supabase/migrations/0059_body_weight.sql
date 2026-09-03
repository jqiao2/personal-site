-- Daily weigh-ins from the smart scale — a time series, not a threshold.
--
-- Weight was already recorded in athlete_thresholds.weight_kg, but that table
-- is versioned by effective_from and thresholdsOn() reads the single latest
-- row on or before a date. A weight-only row per day would therefore blank
-- out FTP/LTHR for every activity scored on that day. Daily body mass is a
-- different shape of data and gets its own table.
--
-- One canonical weight per calendar day (primary key on measured_on, upsert):
-- a trend graph wants one point per day, and a scale that fires twice in a
-- morning should resolve to the last reading, not two.
--
-- RLS on with NO policy, like strava_auth (0045): body measurements are
-- private. The anon client (supabasePublic) can never read them; only the
-- service-role key (supabaseAdmin) touches this table, and only from server
-- code that has already checked requireOwner or the sync token.
create table if not exists public.body_weight (
	measured_on date        primary key,
	weight_kg   double precision not null check (weight_kg > 20 and weight_kg < 300),
	source      text        not null default 'apple_health',
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now()
);

comment on table public.body_weight is
	'Daily body mass from the smart scale via Apple Health. One row per day (upsert on measured_on). RLS on, no policy — private, service-role only. Fed by POST /api/activities/weight; read by /activities/athlete. See ACTIVITIES.md.';

alter table public.body_weight enable row level security;
