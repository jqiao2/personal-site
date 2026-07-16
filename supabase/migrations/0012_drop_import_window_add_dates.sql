-- Drop the remaining Letterboxd import-window dates (follow-up to 0011).
--
-- 0011 cleared the 2021-09-14 batch, but that was only the largest day of a
-- longer backfill. `watched.csv` has no watch date — its "Date" column is when a
-- film was ADDED to the watched list — yet backfill-letterboxd.mjs feeds that
-- column into `first_watched` (see its Phase 4). So every film marked watched
-- while working through the back catalogue in autumn 2021 carries the day it was
-- catalogued, not the day it was seen: 56 films on 2021-09-15, 39 on 2021-10-14,
-- 34 on 2021-09-25. Those are cataloguing sessions, not viewing sessions.
--
-- Rule: within the import window, a date is only trustworthy if a diary entry
-- backs it — the diary is the one export that records an actual viewing date.
-- Films with no dated diary entry get their first watch set back to unknown.
-- This clears 186 rows (2021-09-15 .. 2021-11-15) and keeps the 24 diary-backed
-- ones. Dates outside the window are left alone: from 2022 on, films were logged
-- close to when they were watched, so the add-date is a fair proxy.

update public.watched w
set first_watched = null
where w.first_watched >= '2021-09-01T00:00:00Z'
  and w.first_watched <  '2022-01-01T00:00:00Z'
  and not exists (
    select 1
    from public.logs l
    where l.movie_id = w.movie_id
      and l.deleted_at is null
      and l.watched_date is not null
  );
