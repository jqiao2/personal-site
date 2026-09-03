-- Height, alongside the other athlete measurements.
--
-- It lives in athlete_thresholds rather than a settings singleton because it
-- is the same shape as everything already there: a measurement that is true
-- from a date until the next one supersedes it. Nothing computes with it yet
-- (no exertion rung takes height); it is recorded so /activities/athlete can
-- show the athlete's body alongside the numbers derived from it.
alter table public.athlete_thresholds
	add column if not exists height_cm double precision;

comment on column public.athlete_thresholds.height_cm is
	'Recorded, not computed with. Versioned like the rest of the row.';
