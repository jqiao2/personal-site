-- A private note on a restaurant visit — the meal log's twin of 0052/0053.
-- `review` is the public write-up; this is the rest of the meal.
--
-- WHY THIS COLUMN IS NOT IN restaurant_diary. That view (0030) is granted to
-- anon and is what every public meal read selects from (getVisit, listDiary,
-- the month cards). Leaving private_note out of it means no public path can
-- name the column. The one reader is getVisit(id, includePrivate), which fetches
-- the note off the base table with the service-role client and only when the
-- caller has proved it is the owner. If a later migration recreates
-- restaurant_diary, do not add private_note to it.
alter table public.restaurant_visits add column if not exists private_note text;

comment on column public.restaurant_visits.private_note is
	'Owner-only note on the visit. Never selected by a visitor-reachable read; deliberately absent from restaurant_diary.';
