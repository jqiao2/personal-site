-- Drop the fake first-watch dates left by the Letterboxd backfill.
--
-- Letterboxd's "watched" export carries no per-film watch date, so the import
-- stamped every pre-existing film with the day the export was taken (2021-09-14).
-- Those 313 rows aren't real watch dates — the films were seen at unknown times
-- before that. Null them out so "unknown" is honestly modelled as unknown rather
-- than as a single implausible 313-film day, which otherwise dominates the 2021
-- year stats.
--
-- No diary row claims 2021-09-14 as its watched_date, so nothing real is lost.
-- Films whose first watch IS known (from a diary entry, or logged since) keep it.

-- `first_watched` becomes "the first watch, if known".
alter table public.watched alter column first_watched drop not null;

update public.watched
set first_watched = null
where first_watched >= '2021-09-14T00:00:00Z'
  and first_watched <  '2021-09-15T00:00:00Z';
