-- Link an activity to a meal: the ride to the pizza place, the run that ended
-- at brunch.
--
-- Many-to-many, because both directions happen: one ride can stop at two cafés,
-- and one dinner can sit between the ride there and the ride home. A join table
-- rather than a column on either side, since a column would only hold one.
--
-- Both sides soft-delete, so the cascades only fire on a hard delete; a link to
-- a soft-deleted row is dropped at read time in src/lib/activity-meals.ts.
create table if not exists public.activity_meals (
	activity_id bigint not null references public.activities (id) on delete cascade,
	visit_id    bigint not null references public.restaurant_visits (id) on delete cascade,
	created_at  timestamptz not null default now(),
	primary key (activity_id, visit_id)
);

-- The primary key covers lookups by activity; this covers lookups by meal.
create index if not exists activity_meals_visit_idx on public.activity_meals (visit_id);

-- RLS on, no policies: same posture as journal_pins (0047). Reads go through the
-- service role, and a private activity is dropped for a visitor in app code.
alter table public.activity_meals enable row level security;
