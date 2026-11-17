-- The flight poster's link to the site (/projects/flight-poster/admin).
--
-- One row. The board (jqiao2/flight-poster) POSTs its status to
-- /api/flight-poster/sync on every poll and gets back `config` and
-- `pending_show` in the reply; the owner edits those two from the admin page.
-- `config` holds only the behavior fields of the board's config.json, in the
-- same shape; Wi-Fi, OTA password and API URLs stay on the SD card.
create table if not exists public.flight_poster (
	id           integer primary key default 1 check (id = 1),
	config       jsonb not null default '{}',
	pending_show text,
	status       jsonb,
	cities       jsonb not null default '[]',
	synced_at    timestamptz
);

insert into public.flight_poster (id) values (1) on conflict do nothing;

-- RLS on with no policy: the anon key reads nothing. The site reads and writes
-- through the service role, after requireOwner() or the board's bearer token.
alter table public.flight_poster enable row level security;
