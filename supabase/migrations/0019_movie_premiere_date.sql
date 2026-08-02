-- Cache TMDB's earliest-anywhere release date alongside the US-preferred one (0014).
--
-- `release_date`/`release_year` prefer the US theatrical run (see preferredReleaseDate
-- in src/lib/tmdb.ts), which is the date the site displays. YTS indexes films by their
-- premiere year instead — TMDB's top-level `release_date` — so a film that premiered at
-- a festival the year before its US release is filed under the earlier year there, and
-- the film page's Download search finds nothing.
--
-- Kept as its own column rather than re-deriving on the fly: the film page renders from
-- the cache row without a live TMDB call, and the two dates are genuinely different
-- facts. Also the ground the eventual premiere-vs-theatrical display toggle stands on.
--
-- Populated by the credits backfill (scripts/backfill-credits.mjs) and, going forward,
-- by the normal on-demand TMDB sync (syncMovieFromTmdb).

alter table public.movies
	add column if not exists premiere_date date;  -- TMDB top-level "YYYY-MM-DD"; null when unknown
