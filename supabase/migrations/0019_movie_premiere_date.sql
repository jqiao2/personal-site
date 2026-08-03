-- Cache the earliest-release-anywhere date alongside the US-preferred one (0014).
--
-- `release_date`/`release_year` are the film's first US opening (see preferredReleaseDate
-- in src/lib/tmdb.ts), which is the date the site displays. YTS indexes films by their
-- premiere year instead, so a film that premiered at a festival the year before its US
-- release is filed under the earlier year there, and the film page's Download search
-- finds nothing.
--
-- Kept as its own column rather than re-deriving on the fly: the film page renders from
-- the cache row without a live TMDB call, and the two dates are genuinely different
-- facts. Also the ground the eventual premiere-vs-theatrical display toggle stands on.
--
-- Populated by the credits backfill (scripts/backfill-credits.mjs) and, going forward,
-- by the normal on-demand TMDB sync (syncMovieFromTmdb).

alter table public.movies
	add column if not exists premiere_date date;  -- earliest release anywhere; null when unknown
