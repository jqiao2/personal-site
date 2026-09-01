-- Price is the restaurant's, and now only the restaurant's.
--
-- `restaurants.price_band` was always where the value lived — the column has
-- been on the place since 0030. What made it read as a per-meal field was that
-- `restaurant_diary` carried it down onto every visit row, so a visit appeared
-- to know what it cost. It never did: two meals at the same counter reported
-- the same band because it is one column, and a diary that seems to record a
-- price but reports the same number for a $9 bowl and a $60 dinner is worse
-- than one that doesn't mention money at all.
--
-- Nothing read the column off the view — see the comment at the head of
-- restaurants/diary.astro, which already says so in words — so this only makes
-- the model say what the pages were doing. The composer's Price control moves
-- to the restaurant editor in the same change.
--
-- Dropped and recreated rather than replaced: `create or replace view` can add
-- a column at the end and nothing else, and this removes one from the middle.

drop view if exists public.restaurant_diary;

create view public.restaurant_diary
with (security_invoker = true) as
select
	v.id,
	v.restaurant_id,
	v.visited_on,
	v.rating,
	v.verdict,
	v.hearted,
	v.revisit,
	v.friends,
	v.review,
	v.tags,
	v.created_at,
	v.updated_at,
	r.name          as restaurant_name,
	r.cuisines,
	r.neighborhood,
	r.borough,
	r.city,
	r.state_region,
	r.country,
	coalesce(p.photo_count, 0) as photo_count
from public.restaurant_visits v
join public.restaurants r on r.id = v.restaurant_id
left join (
	select visit_id, count(*) as photo_count
	from public.restaurant_photos
	group by visit_id
) p on p.visit_id = v.id
where v.deleted_at is null;

grant select on public.restaurant_diary to anon, authenticated;

comment on column public.restaurants.price_band is
	'What the place costs, as one of four bands. A property of the restaurant, never of a meal: it is edited on the place page and no diary row prints it.';
