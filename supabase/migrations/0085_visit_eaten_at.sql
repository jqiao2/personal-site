-- When a meal was eaten, from its photographs' camera clock, so two visits on one
-- day read in the order they happened rather than the order they were logged.
-- Zoneless, like food_inbox.taken_at: the time where the meal was. Null when no
-- photograph said; those sort as the day's earliest.
alter table public.restaurant_visits add column if not exists eaten_at timestamp;

-- Visits already logged from the photo inbox: their earliest photograph.
update public.restaurant_visits v
set eaten_at = f.first_taken
from (
	select visit_id, min(taken_at) as first_taken
	from public.food_inbox
	where status = 'logged' and visit_id is not null
	group by visit_id
) f
where f.visit_id = v.id and v.eaten_at is null;

-- Appended at the end, which `create or replace` allows (wiki 0003). The body is
-- 0066's otherwise.
create or replace view public.restaurant_diary
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
	coalesce(p.photo_count, 0) as photo_count,
	v.eaten_at
from public.restaurant_visits v
join public.restaurants r on r.id = v.restaurant_id
left join (
	select visit_id, count(*) as photo_count
	from public.restaurant_photos
	group by visit_id
) p on p.visit_id = v.id
where v.deleted_at is null and r.merged_into is null;

grant select on public.restaurant_diary to anon, authenticated;
