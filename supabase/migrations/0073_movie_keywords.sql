-- TMDB's keywords for a film: plot/setting microgenres plus mood adjectives
-- ("melancholy", "tense", "whimsical") that place it in the /films/stats taste
-- space. Filled by scripts/backfill-movie-keywords.mjs and kept up by the movie
-- cache (films.ts, syncMovieFromTmdb); null until then.
alter table movies add column keywords text[];
