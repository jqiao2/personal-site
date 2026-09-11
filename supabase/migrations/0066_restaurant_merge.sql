-- Fold duplicate restaurant rows into one, non-destructively.
--
-- The same real place can end up as several `restaurants` rows: added once to
-- the to-try list from one gazetteer source's search, then logged as a visit
-- from another source, which COPIES its values into a fresh row rather than
-- joining. The two rows then desync — the visit lands on one, the to-try flag
-- stays on the other, and the place never leaves the to-try list even though it
-- has been eaten at (the view's `on_to_try` only goes false when the visit and
-- the flag live on the SAME row).
--
-- The fix is a merge, not a delete: point the duplicate at its canonical row
-- with a self-FK and hide it everywhere. Nothing is destroyed, so a wrong merge
-- is one `update … set merged_into = null` away from being undone.

alter table public.restaurants
	add column if not exists merged_into bigint references public.restaurants(id);

comment on column public.restaurants.merged_into is
	'Non-null = this row is a duplicate folded into row `merged_into`. Its visits have been repointed there and it is hidden from every view. Clear it to un-merge.';

-- The duplicates are the rare rows; index only them.
create index if not exists restaurants_merged_into_idx
	on public.restaurants (merged_into)
	where merged_into is not null;

-- ---------------------------------------------------------------------------
-- Both views drop merged rows. `create or replace view` cannot add a WHERE to
-- an existing view (it can only append columns), so each is dropped and rebuilt
-- verbatim from its latest definition — restaurant_places from 0048, and
-- restaurant_diary from 0049 — with the one new predicate on the base row.
-- ---------------------------------------------------------------------------
drop view if exists public.restaurant_places;

create view public.restaurant_places
with (security_invoker = true) as
with visits as (
	select
		v.restaurant_id,
		count(*)                                            as visit_count,
		min(v.visited_on)                                   as first_visit,
		max(v.visited_on)                                   as last_visit,
		avg(v.rating)                                       as avg_rating,
		bool_or(v.hearted)                                  as hearted,
		count(*) filter (where v.rating is not null)        as rated_count
	from public.restaurant_visits v
	where v.deleted_at is null
	group by v.restaurant_id
),
latest as (
	select distinct on (v.restaurant_id)
		v.restaurant_id,
		v.verdict     as latest_verdict,
		v.visited_on  as latest_verdict_on
	from public.restaurant_visits v
	where v.deleted_at is null and v.verdict is not null
	order by v.restaurant_id, v.visited_on desc, v.id desc
),
cover as (
	select distinct on (v.restaurant_id)
		v.restaurant_id,
		p.storage_path as cover_path,
		p.width        as cover_width,
		p.height       as cover_height
	from public.restaurant_photos p
	join public.restaurant_visits v on v.id = p.visit_id
	where v.deleted_at is null
	order by v.restaurant_id, v.visited_on desc, p.position, p.id
),
photo_totals as (
	select v.restaurant_id, count(p.id) as photo_count
	from public.restaurant_photos p
	join public.restaurant_visits v on v.id = p.visit_id
	where v.deleted_at is null
	group by v.restaurant_id
)
select
	r.*,
	coalesce(vs.visit_count, 0)  as visit_count,
	vs.first_visit,
	vs.last_visit,
	round(vs.avg_rating, 2)      as avg_rating,
	coalesce(vs.rated_count, 0)  as rated_count,
	coalesce(vs.hearted, false)  as hearted,
	l.latest_verdict,
	l.latest_verdict_on,
	c.cover_path,
	c.cover_width,
	c.cover_height,
	coalesce(pt.photo_count, 0)  as photo_count,
	(r.to_try_added_at is not null and coalesce(vs.visit_count, 0) = 0) as on_to_try
from public.restaurants r
left join visits       vs on vs.restaurant_id = r.id
left join latest       l  on l.restaurant_id  = r.id
left join cover        c  on c.restaurant_id  = r.id
left join photo_totals pt on pt.restaurant_id = r.id
where r.merged_into is null;

grant select on public.restaurant_places to anon, authenticated;

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
where v.deleted_at is null and r.merged_into is null;

grant select on public.restaurant_diary to anon, authenticated;
