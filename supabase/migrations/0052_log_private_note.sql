-- A private note on a diary entry: the part of a watch that is nobody else's
-- business. `review_text` is the public opinion; this is the rest of the night.
--
-- WHY THIS COLUMN IS NOT IN logs_with_movie. That view is the read model every
-- public film list selects from (listLogs, the feeds, the month cards), and it
-- is reachable with the anon key under 0001's "public read logs" policy. Leaving
-- private_note out of it means no public path can select the column even by
-- accident — the visitor query has nowhere to name it. The one reader is
-- getDiaryEntry(id, includePrivate), which asks for it off the base table and
-- only when the caller has proved it is the owner.
--
-- So: if a later migration recreates logs_with_movie, do not add private_note
-- to it.
alter table public.logs add column if not exists private_note text;

comment on column public.logs.private_note is
	'Owner-only note on the entry. Never selected by a visitor-reachable read; deliberately absent from logs_with_movie.';
