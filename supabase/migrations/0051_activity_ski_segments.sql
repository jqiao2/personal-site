-- A hand-corrected run/lift partition for a ski day.
--
-- src/lib/ski.ts auto-detects runs and lifts from the altitude sawtooth, which
-- is right almost always — but "almost" is why this column exists: a lift the
-- owner actually hiked, or a cat-track the detector called a run, is a judgement
-- only a person can make. When set, this REPLACES detection for the activity,
-- both in the on-screen breakdown and in the exertion score (a reclassified
-- lift now counts as active descent).
--
-- Shape: a JSON array in day order, one entry per segment, each
--   { "t0": <seconds from start>, "t1": <seconds from start>, "type": "run"|"lift"|"idle" }
-- Times, not sample indices, so the edit survives a re-import at a different
-- recording resolution — ski.ts maps them back to the nearest samples. Null
-- (the default) means "use auto-detection", so nothing here needs backfilling.
--
-- No view touches this column (the list/feed views don't show runs), so no view
-- rebuild is required — cf. wiki pattern 0003.

alter table public.activities
	add column if not exists ski_segments jsonb;

comment on column public.activities.ski_segments is
	'Owner-corrected run/lift partition for a ski day (array of {t0,t1,type} in seconds from start). Null = auto-detect from the altitude stream. Overrides detection for both display and exertion. See src/lib/ski.ts.';
