-- Screening Room: the "queued" watchlist — films scheduled to watch on a day,
-- at home or in a theatre. Distinct from `watchlist` (an unordered "to watch"
-- pile): a queue entry has a date and, optionally, a synced Google Calendar
-- event, so the two round-trip.
--
-- One entry per movie (unique movie_id, like watchlist): re-scheduling a film
-- moves its date rather than stacking a second showing. Revisit if double
-- features ever matter.
create table if not exists public.screening_queue (
	id              bigint generated always as identity primary key,
	movie_id        bigint not null unique references public.movies (id) on delete cascade,
	scheduled_date  date    not null,          -- the day planned to watch
	venue           text,                       -- theatre name (e.g. "AMC 34th Street 14"); null = at home
	-- The Google Calendar event this entry is mirrored by, when synced. Null for a
	-- manual add that hasn't been pushed, or when Calendar isn't configured. Lets a
	-- later edit/remove update or delete the matching event, and dedupes the inbound
	-- parse (an event we created is already here under its own id).
	google_event_id text,
	source          text    not null default 'manual',  -- 'manual' | 'calendar'
	created_at      timestamptz not null default now()
);

create index if not exists screening_queue_date_idx on public.screening_queue (scheduled_date);
create index if not exists screening_queue_event_idx on public.screening_queue (google_event_id);

-- Public read, service-role write — same posture as the rest of the film log.
alter table public.screening_queue enable row level security;
create policy "public read screening_queue" on public.screening_queue for select using (true);
