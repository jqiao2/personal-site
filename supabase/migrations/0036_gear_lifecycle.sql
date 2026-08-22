-- Gear lifecycle — /activities/gear and /activities/gear/:id.
--
-- 0034 gave gear an identity (kind, name, retired_at, a denormalised
-- distance_m). This adds the two things a gear PAGE needs that an identity
-- doesn't: when the thing entered service, and — for bikes only — the parts
-- bolted to it and how long each has been there.
--
-- WHY COMPONENTS ARE ROWS WITH DATES, NOT COLUMNS ON THE BIKE. "Current chain"
-- as a column would answer "what's on it" and destroy the answer to "how long
-- did the last one last" — which is the only question that makes the next
-- replacement predictable. So a component is an INSTANCE with installed_on and
-- removed_on: replacing a chain closes one row and opens another, and the
-- history is the table rather than something the table forgot.
--
-- WHY NO 'miles on this component' COLUMN. It would be a denormalised total
-- that must be re-summed every time an old ride is re-tagged to a different
-- bike. The component's mileage is `sum(activities.distance_m) where gear_id =
-- this bike and local_date between installed_on and coalesce(removed_on,
-- today)` — derived, always right, and cheap at this size (src/lib/gear.ts).
-- `baseline_distance_m` is the one number that CAN'T be derived: miles the part
-- carried in from before it was tracked, or from another bike.

-- ---------------------------------------------------------------------------
-- activity_gear — when it entered service.
-- ---------------------------------------------------------------------------
-- A date, not a timestamptz like retired_at: nobody knows the hour they first
-- rode a bike, and pretending to is what makes a timestamp lie. retired_at
-- stays as it is (0034 shipped it) and the UI treats it as a date.
alter table public.activity_gear
	add column if not exists first_used_on date;

comment on column public.activity_gear.first_used_on is
	'First use. Null means "unknown" — the gear page then falls back to the earliest activity tagged to it, which is a floor, not the truth.';

-- ---------------------------------------------------------------------------
-- gear_components — one row per PART INSTANCE, open or closed.
-- ---------------------------------------------------------------------------
create table if not exists public.gear_components (
	id          bigint generated always as identity primary key,
	gear_id     bigint not null references public.activity_gear (id) on delete cascade,

	-- The closed vocabulary in src/lib/gear.ts (COMPONENT_KINDS) — that module
	-- owns the labels, the wear axis and the replacement intervals; this
	-- constraint only owns "is it one of them". Keep the two in step.
	kind        text not null check (kind in (
		'chain', 'cassette', 'chainrings', 'brake_pads', 'brake_rotors',
		'tires', 'sealant', 'valves', 'bar_tape', 'cables', 'bottom_bracket',
		'headset_bearings', 'wheel_bearings', 'cleats', 'other'
	)),

	-- What it actually is ("Shimano CN-M8100"). Optional: "the chain" is a
	-- complete answer for parts you never chose deliberately.
	label       text,

	installed_on date not null,
	-- Null = still fitted. Setting it is what "replaced" means; the row stays.
	removed_on   date,

	-- Miles the part arrived with — carried over from another bike, or from
	-- before any of this was tracked. The only mileage here that isn't derived.
	baseline_distance_m double precision not null default 0,

	-- Brake pads wear by thickness, rotors by thickness, bearings by feel. One
	-- free-text line covers all three rather than three typed measurement
	-- columns that would each be filled in twice and then never again.
	condition   text,
	notes       text,

	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now(),

	constraint gear_components_dates_ordered check (removed_on is null or removed_on >= installed_on)
);

comment on column public.gear_components.removed_on is
	'Null = currently fitted. Replacing a part closes this row and opens a new one — the history IS the table.';
comment on column public.gear_components.condition is
	'Free text for the wear axes that aren''t miles: pad thickness, rotor thickness, "bearings feel notchy".';

create index if not exists gear_components_gear_id_idx on public.gear_components (gear_id);
-- The detail page's two queries: "what's fitted now" and "everything, newest
-- first". Both start from gear_id + installed_on.
create index if not exists gear_components_current_idx
	on public.gear_components (gear_id, installed_on desc) where removed_on is null;

alter table public.gear_components enable row level security;
drop policy if exists "public read gear_components" on public.gear_components;
create policy "public read gear_components" on public.gear_components for select using (true);
