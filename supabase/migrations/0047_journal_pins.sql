-- Pinned journal entries: the cross-section replacement for the old per-section
-- "favorites". One flat table, one row per pinned thing, across all four tracks.
--
-- `ref_id` points into a different table per `track`:
--   film → logs.id              (/films/diary/{id})
--   book → books.id             (/books/{id})
--   meal → restaurant_visits.id (/restaurants/diary/{id})
--   move → activities.id        (/activities/{id})
-- No foreign key, because there is no one table to point at — a dangling pin
-- (its entry deleted) is dropped at read time in src/lib/pins.ts instead.
create table journal_pins (
	id bigint generated always as identity primary key,
	track text not null check (track in ('film', 'book', 'meal', 'move')),
	ref_id bigint not null,
	pinned_at timestamptz not null default now(),
	unique (track, ref_id)
);

-- The 10-pin cap is enforced in application code (src/lib/pins.ts, MAX_PINS),
-- NOT here: the limit is a product choice that wants a friendly "here's your
-- current list, remove one" response, which a DB constraint can't give.

-- RLS on, no policies: same posture as the reading tables (migration 0020).
-- Every read and write goes through supabaseAdmin server-side (privacy is
-- applied in app code), so the anon client seeing nothing is correct.
alter table journal_pins enable row level security;
