-- Re-base release_year onto the premiere date (earliest release anywhere) instead of
-- the US opening.
--
-- release_year was derived from release_date, the first US opening (preferredReleaseDate
-- in src/lib/tmdb.ts). The site now sorts and displays by the more widely-accepted
-- release year — the premiere year, the same year YTS files a film under — and reserves
-- the US date solely for the Watchlist's "upcoming"/"Out …" copy. syncMovieFromTmdb now
-- writes release_year from premiere_date; this brings already-cached rows in line.
--
-- premiere_date (0019) is already populated for cached films by the credits backfill and
-- on-demand sync. Rows still missing it keep their old year and self-correct on next sync.

update public.movies
	set release_year = extract(year from premiere_date)::int
	where premiere_date is not null
		and extract(year from premiere_date)::int is distinct from release_year;
