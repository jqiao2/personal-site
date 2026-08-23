-- APPLIED BY HAND (through PostgREST with the service-role key) on
-- 2026-08-22, because `supabase link` currently fails in this worktree with a
-- CLI-side parse error on the API-keys response, so `db push` could not run.
-- It is therefore NOT in `supabase_migrations.schema_migrations`, and a later
-- `db push` WILL run this file. Both statements are written to survive that:
-- the update is idempotent and the insert is guarded by `not exists`.
-- See CLAUDE.md on why the file has to exist either way.

-- The trail shoe changed hands on 2026-07-01: the HOKA Speedgoat 5 came out of
-- service and an Altra Lone Peak 9 went in.
--
-- Stated by the owner (2026-08-22), not inferred from the log — the Speedgoat
-- has no activities tagged to it yet, so nothing in the data could have told
-- us. Both halves are recorded because a retirement without its replacement
-- reads as "stopped trail running", and a replacement without its retirement
-- leaves two active trail shoes and no way to know which one a hike belongs to.
-- That question is now answerable, which is what `scripts/add-activities.mjs`
-- needs to default a hike or a trail run to the right pair.

-- Matched on id AND name together, as 0038 does: the id identifies the row and
-- the name asserts the id still means what it meant when this was written.
update public.activity_gear
set retired_at = timestamptz '2026-07-01 00:00:00+00', updated_at = now()
where (id, name) = (27, 'HOKA Speedgoat 5');

-- `first_used_on` is a date rather than a timestamp for the reason 0036 gives:
-- nobody knows the hour they first wore a pair of shoes.
insert into public.activity_gear (kind, name, brand, model, first_used_on)
select 'shoes', 'Altra Lone Peak 9', 'Altra', 'Lone Peak 9', date '2026-07-01'
where not exists (
	select 1 from public.activity_gear where name = 'Altra Lone Peak 9'
);
