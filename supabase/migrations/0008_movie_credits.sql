-- Cache TMDB genre + credit facts on the movie row, for the Stats page.
--
-- The `movies` table is a lightweight TMDB cache (see 0001). The Stats page needs
-- to aggregate across the whole watched collection — most-watched genres, spoken
-- languages, production countries, top directors and actors — and hitting TMDB per
-- film on every page load isn't viable. So we denormalize a handful of facts onto
-- each movie row: text[] name lists, small enough to aggregate in the app.
--
-- These are pure movie metadata (not the owner's relationship to the film), so
-- they belong on `movies`, alongside title/runtime/overview. They're populated by
-- the credits backfill (scripts/backfill-credits.mjs) and, going forward, by the
-- normal on-demand TMDB sync (syncMovieFromTmdb).

alter table public.movies
	add column if not exists genres            text[],  -- e.g. {Drama,Thriller}
	add column if not exists languages         text[],  -- spoken languages, English names {English,Japanese}
	add column if not exists countries         text[],  -- production countries {Japan,France}
	add column if not exists directors         text[],  -- crew where job = Director
	add column if not exists actors            text[],  -- top ~10 billed cast, in order
	add column if not exists credits_synced_at timestamptz;  -- null = never fetched credits

-- Lets the backfill find films whose credits haven't been fetched yet.
create index if not exists movies_credits_synced_at_idx
	on public.movies (credits_synced_at)
	where credits_synced_at is null;
