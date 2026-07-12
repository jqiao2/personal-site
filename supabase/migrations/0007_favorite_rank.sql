-- Add a display order to favorites so they can be reordered (drag-and-drop).
--
-- favorite_rank is only meaningful when favorite = true; lower ranks show first
-- ("the first is shown top-left"). It's plain data — no cap trigger needed, since
-- the 4-favorite limit is already enforced by watched_max_favorites (0006).

alter table public.watched
	add column if not exists favorite_rank smallint;

-- Backfill a stable initial order for any existing favorites (newest watched
-- first), so they don't all share a null rank.
with ranked as (
	select id, (row_number() over (order by first_watched desc) - 1) as rnk
	from public.watched
	where favorite
)
update public.watched w
set favorite_rank = ranked.rnk
from ranked
where ranked.id = w.id;
