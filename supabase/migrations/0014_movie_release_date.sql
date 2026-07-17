-- Cache TMDB's full release date on the movie row, alongside release_year (0001).
--
-- `release_year` alone can't answer "has this come out yet?" — for a film dated
-- later this year, the year matches the current year but the film is still
-- unreleased. The Watchlist badges upcoming films, so it needs the real date.
--
-- Kept as a separate column rather than replacing release_year: the year is what
-- nearly every view displays, it's already indexed into the decade filters, and
-- TMDB has plenty of rows with no usable date at all (null here, year still set
-- from an earlier import).
--
-- Populated by the credits backfill (scripts/backfill-credits.mjs) and, going
-- forward, by the normal on-demand TMDB sync (syncMovieFromTmdb).

alter table public.movies
	add column if not exists release_date date;  -- TMDB "YYYY-MM-DD"; null when unknown
