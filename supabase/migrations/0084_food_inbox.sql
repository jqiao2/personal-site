-- Photographs of food from the owner's camera roll that have no visit yet
-- (/restaurants/inbox). scripts/food-inbox on the owner's PC writes the pending
-- rows; logging or dismissing one is what takes it off the page.
--
-- A row outlives both answers as a tombstone, because the photograph is still
-- in the camera roll: `sha256` is what stops the next sync offering it again.
create table if not exists public.food_inbox (
	id           bigint generated always as identity primary key,
	sha256       text        not null unique,
	filename     text        not null,
	-- In the private bucket below. Null once logged or dismissed: the object is
	-- gone, and a logged one has been copied to R2 with the visit's others.
	storage_path text,
	width        integer     not null,
	height       integer     not null,
	-- The camera's own clock, zoneless: the calendar day where the meal was.
	taken_at     timestamp   not null,
	lat          double precision check (lat between -90 and 90),
	lng          double precision check (lng between -180 and 180),
	score        real        not null,
	status       text        not null default 'pending'
		check (status in ('pending', 'logged', 'dismissed')),
	visit_id     bigint      references public.restaurant_visits (id) on delete set null,
	created_at   timestamptz not null default now()
);

-- RLS on with no policy: the anon key reads nothing. Where the owner has been,
-- and every photograph not yet published, stay behind the service role.
alter table public.food_inbox enable row level security;

-- PRIVATE, which is why these do not wait in R2: that bucket is public, and a
-- camera roll's false positives are mostly people. A photograph is readable
-- through the owner-only route until it is logged, and public only after.
insert into storage.buckets (id, name, public)
values ('food-inbox', 'food-inbox', false)
on conflict (id) do nothing;
