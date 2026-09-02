-- A sixth exertion method: 'ski'.
--
-- A lift-served ski or snowboard day cannot be scored on its file duration —
-- most of it is chairlift and lodge, and this archive's Slopes exports carry a
-- moving_seconds that is simply broken (465s for a full day with 10,000m of
-- vertical). src/lib/ski.ts recovers the active-descent time from the altitude
-- stream, and exertion.ts scores that time on an active-skiing MET, reporting
-- the new method 'ski' (see the cascade's rung 4.5). The CHECK constraint that
-- guards exertion_method has to admit it.
--
-- Drop-and-recreate rather than a second constraint: keeping the old one would
-- reject 'ski' and the two together can never both pass. The name is Postgres'
-- own auto-generated one from 0034's inline check.

alter table public.activities
	drop constraint if exists activities_exertion_method_check;

alter table public.activities
	add constraint activities_exertion_method_check
	check (exertion_method is null or exertion_method in ('tss', 'hrtss', 'avghr', 'ptss', 'met', 'ski'));
