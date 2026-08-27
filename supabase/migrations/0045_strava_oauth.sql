-- Strava OAuth token store — ACTIVITIES.md §4 step 3, the ongoing-sync path.
--
-- The archive import (step 1) is the owner's own data export and needs no
-- credentials. This is the other half: an OAuth connection that pulls NEW
-- rides as they happen, whose access token expires every six hours and whose
-- refresh token Strava rotates on use. Both live here, not in an env var,
-- precisely because the refresh token changes — a value that rewrites itself
-- can't be a deploy-time constant.
--
-- One athlete, one connection, so exactly one row (id is fixed at 1).
--
-- RLS is enabled with NO policy on purpose: these are secrets. The anon key
-- (supabasePublic) is subject to RLS and so can never read them; only the
-- service-role key (supabaseAdmin), which bypasses RLS, touches this table,
-- and it's only ever imported into server code that has already checked the
-- owner session (or a cron secret).
create table if not exists public.strava_auth (
	id            smallint    primary key default 1 check (id = 1),
	athlete_id    bigint,
	access_token  text        not null,
	refresh_token text        not null,
	-- When access_token dies (Strava's `expires_at`, epoch seconds, stored as a
	-- timestamp). getAccessToken() refreshes when this is within a minute.
	expires_at    timestamptz not null,
	scope         text,
	-- The polling watermark: only activities that started after this are pulled.
	-- Set to "now" at connect time, so the connection syncs rides made AFTER it
	-- was authorised — the whole back-catalogue is the archive importer's job,
	-- not this one's.
	last_sync_at  timestamptz,
	created_at    timestamptz not null default now(),
	updated_at    timestamptz not null default now()
);

comment on table public.strava_auth is
	'Single-row (id=1) Strava OAuth token store. RLS on with no policy — tokens are secrets, reachable only by the service-role key. See src/lib/strava.ts.';
comment on column public.strava_auth.last_sync_at is
	'Polling watermark: activities with start after this are fetched. Set to now() at connect so only rides made after authorising are pulled — history is the archive importer''s job.';

alter table public.strava_auth enable row level security;
