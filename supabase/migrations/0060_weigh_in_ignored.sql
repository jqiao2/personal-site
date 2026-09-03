-- Outlier guard on weigh-ins. A scale mis-read (a foot half-off, a kid, a bag
-- on the platform) lands as a value wildly off the trend; the ingest marks any
-- reading more than 10% from the last accepted weight as `ignored` rather than
-- dropping it, so the record survives but the graph and the "current weight"
-- skip it — and it never becomes the baseline the next reading is judged against.
--
-- default false: a reading is trusted unless the ingest says otherwise, and a
-- row written before this column existed (there are none yet, but still) reads
-- as accepted.
alter table public.body_weight
	add column if not exists ignored boolean not null default false;

comment on column public.body_weight.ignored is
	'Set by the ingest when a reading is >10% off the last accepted weight — a likely scale mis-read. Stored but excluded from the series/current value and from being a baseline. See src/lib/athlete.ts flagOutliers.';
