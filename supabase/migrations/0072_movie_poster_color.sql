-- The dominant colour of a film's poster, "#rrggbb". The closet (/films/closet)
-- prints each disc's spine in it. Derived from the poster image, so it is filled
-- by scripts/backfill-poster-colors.mjs and kept up by the movie cache
-- (films.ts, syncMovieFromTmdb); null until then, or when there is no poster.
alter table movies
	add column poster_color text check (poster_color ~ '^#[0-9a-f]{6}$');
