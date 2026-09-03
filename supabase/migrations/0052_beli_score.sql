-- Beli's own 0–10 score, kept on places brought in from a Beli export.
--
-- The restaurant log's judgement lives on a VISIT: a star rating (0.5–5) and
-- the return verdict (see 0030). Beli's number is a different thing — one
-- ranking-derived score per place, on a 0–10 scale, computed by their app from
-- pairwise comparisons rather than assigned. It does not map cleanly onto
-- either of ours (a star rating is derived from it on import, but that is a
-- lossy guess), so the real number is kept here rather than thrown away.
--
-- On the PLACE, not the visit: Beli has one score per restaurant, not one per
-- meal, so a visit-level column would repeat it or force a choice about which
-- visit owns it. Null for everything not from Beli, which is most of the log.
alter table public.restaurants
	add column if not exists beli_score numeric(4, 2)
		check (beli_score is null or (beli_score >= 0 and beli_score <= 10));

comment on column public.restaurants.beli_score is
	'Beli''s own 0–10 ranking score, for places imported from a Beli export. Null everywhere else. The visit''s star rating is derived from it but this is the source number.';
