-- Two more cached TMDB facts on the movie row: the film's original language and
-- its US content rating (MPA certification).
--
-- `languages` (migration 0008) holds every SPOKEN language, whose TMDB order
-- isn't reliably primary-first — so "the language" of a film is better taken from
-- TMDB's original_language. We store it resolved to an English name (e.g.
-- "Japanese"), and use it for both the film page's meta row and the Stats
-- "Languages" breakdown. The `languages` column stays as-is (unused for display).
--
-- `mpa_rating` is the US certification (G / PG / PG-13 / R / NC-17 …) from TMDB's
-- release_dates, shown on the film page. Null when TMDB has no US certification
-- (common for older or non-US films).
--
-- Populated by the credits backfill (scripts/backfill-credits.mjs, re-run with
-- --force after this migration) and, going forward, by syncMovieFromTmdb.

alter table public.movies
	add column if not exists original_language text,  -- English name, e.g. "Japanese"
	add column if not exists mpa_rating        text;  -- US certification, e.g. "PG-13"
