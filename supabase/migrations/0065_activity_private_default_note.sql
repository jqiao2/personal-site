-- Comment only: the column default is no longer the whole story.
--
-- 0043 set `private` to `true` for everything and said so in the comment. 0061
-- backfilled the existing rows to public-unless-work-hours, and the importers
-- now apply that same rule to every new activity (defaultPrivate() in
-- src/lib/activity-privacy.ts, called from toRows). The database default still
-- has to be `true` — it is what a row written by hand, without going through
-- the pipeline, falls back to.
comment on column public.activities.private is
	'Owner-only when true. The column default is true (fail closed for any row written outside the ingest pipeline), but an imported activity gets its value from defaultPrivate() in src/lib/activity-privacy.ts: public unless it overlaps Mon-Fri 09:00-17:00 local, which is the rule migration 0061 backfilled with. A visitor sees a private activity as a bare sport icon in the day grid and gets a 404 at its detail page; redaction is enforced by redactActivities in src/lib/activity-privacy.ts.';
