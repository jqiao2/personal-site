-- The owner's subway log: which stations the owner has visited and which track
-- segments they have ridden, as marked on /subway (diagram or map view).
--
-- One row per mark, keyed by the ids in src/scripts/subway-data.js (a station's
-- numeric id, a segment's "svc|a|b"), so marking and unmarking are an insert and
-- a delete. Visitors never read this: the page starts them blank.
--
-- No index beyond the key: every read is the whole table (a few hundred rows),
-- every write hits the key.
create table if not exists public.subway_marks (
	kind      text not null check (kind in ('station', 'segment')),
	ref       text not null,
	marked_at timestamptz not null default now(),
	primary key (kind, ref)
);

-- RLS on, no policies: same posture as journal_pins (0047). Only the owner API
-- reads or writes it, through the service role.
alter table public.subway_marks enable row level security;
