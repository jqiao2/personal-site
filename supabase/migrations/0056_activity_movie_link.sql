-- Link a virtual bike ride to the movie watched during it.
--
-- The owner rides the trainer with a film on, and often writes "Ride movie:
-- {name}" in the notes. This turns that into a real link: the TMDB id resolves
-- to the film's page (/films/movie/{tmdb_id}), which already lists that film's
-- diary entries — so linking to the film covers both "link to the movie page"
-- and "link to the diary entry", and doesn't break when the entry isn't
-- written until the next day (a ride often ends before the film does).
--
-- The title is denormalised alongside the id so the activity page can name the
-- film without a TMDB round-trip or a join to the (possibly-uncached) `movies`
-- table — the same shape as gear_name on activity_list. Both nullable together:
-- an activity with no linked film sets neither.
alter table public.activities
	add column if not exists movie_tmdb_id bigint,
	add column if not exists movie_title   text;

comment on column public.activities.movie_tmdb_id is
	'TMDB id of the film watched during this (virtual) ride. Resolves to /films/movie/{id}, which lists the film''s diary entries. Null for anything with no linked film.';
comment on column public.activities.movie_title is
	'Denormalised title of the linked film, captured at link time so the activity page names it without a TMDB fetch or a join to movies. Travels with movie_tmdb_id.';
