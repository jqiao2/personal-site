-- Add the film-level rating and "like" to `watched`.
--
-- On Letterboxd a rating/like belongs to the FILM, not a specific viewing, so it
-- lives on `watched` (one row per movie). Per-viewing ratings/likes still live on
-- `logs`. This lets the Letterboxd backfill preserve ratings + likes for films
-- that were marked watched but never got a dated diary entry (~540 of them).

alter table public.watched
	add column if not exists rating numeric(2, 1)
		check (rating >= 0.5 and rating <= 5.0 and (rating * 2) = floor(rating * 2)),
	add column if not exists liked boolean not null default false;
