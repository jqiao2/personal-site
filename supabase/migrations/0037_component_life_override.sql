-- Per-instance replacement windows, overriding the defaults in
-- src/lib/gear-wear.ts (COMPONENT_KINDS).
--
-- WHY THIS EXISTS. The defaults are honest guesses about a category — "a road
-- tire lasts 2,000–5,000 miles" — and a category is not a part. A 28mm race
-- tire and a 45mm gravel tire are both `tires` and are not remotely the same
-- question, and the whole point of the wear bar is to say WHEN TO GO AND LOOK
-- at a part that is measured by hand. A window that is wrong by a factor of two
-- sends you to look at the wrong time, which is the only way this feature
-- fails. So the guess is a default, not a fact, and any instance can replace it.
--
-- WHY A WINDOW AND NOT A NUMBER. Same reason the defaults are windows: a chain
-- is not dead at exactly 3,000 miles, it is somewhere between fine and finished
-- across a range. Overriding with a single threshold would quietly change what
-- the bar means for that one part, so an override is the same shape as the
-- thing it overrides — [start looking, replace it].
--
-- WHY ARRAYS RATHER THAN FOUR SCALAR COLUMNS. `[due, overdue]` is exactly the
-- shape ComponentMeta.lifeMiles/lifeMonths already has in TypeScript, so a
-- two-element array round-trips through PostgREST straight into the existing
-- type and the read side is `component.life_miles ?? meta.lifeMiles` — one
-- coalesce instead of four columns to reassemble. The check constraints below
-- are what a fixed-length array type would have given us; Postgres doesn't
-- enforce array length in the type, so it's enforced here.

alter table public.gear_components
	add column if not exists life_miles  integer[],
	add column if not exists life_months integer[];

comment on column public.gear_components.life_miles is
	'Per-instance replacement window in miles, [due, overdue]. Null = use the default for this kind in src/lib/gear-wear.ts.';
comment on column public.gear_components.life_months is
	'Per-instance replacement window in months, [due, overdue]. Null = use the default for this kind.';

-- Both ends present, positive, and in order. A one-element or reversed array
-- would render a wear bar that divides by the wrong end and silently reads
-- backwards — worse than having no override at all.
alter table public.gear_components
	drop constraint if exists gear_components_life_miles_window;
alter table public.gear_components
	add constraint gear_components_life_miles_window check (
		life_miles is null or (
			array_length(life_miles, 1) = 2
			and life_miles[1] > 0
			and life_miles[2] >= life_miles[1]
		)
	);

alter table public.gear_components
	drop constraint if exists gear_components_life_months_window;
alter table public.gear_components
	add constraint gear_components_life_months_window check (
		life_months is null or (
			array_length(life_months, 1) = 2
			and life_months[1] > 0
			and life_months[2] >= life_months[1]
		)
	);
