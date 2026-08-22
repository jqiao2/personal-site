-- `wheels` joins the component vocabulary.
--
-- 0039 filed two wheelsets as `wheel_bearings` on the reasoning that the wheel
-- doesn't wear out but its bearings do. That's true of the bearings and wrong
-- about the wheel: a wheelset is a thing you own, swap between setups, sell,
-- and crack — and it outlives several sets of the bearings inside it. Folding
-- the two together means replacing a bearing either erases the wheel's history
-- or leaves the wheel's mileage counting from a bearing service, and neither is
-- the record anyone wanted.
--
-- So they are separate kinds. `wheels` carries no replacement interval: on disc
-- brakes nothing rubs the rim, so a wheelset has no scheduled life, only miles
-- and a condition ("hairline at the spoke bed").
--
-- The labels and intervals live in src/lib/gear-wear.ts; this constraint only
-- owns "is it one of these", so it has to be restated to admit the new one.

alter table public.gear_components
	drop constraint if exists gear_components_kind_check;

alter table public.gear_components
	add constraint gear_components_kind_check check (kind in (
		'chain', 'cassette', 'chainrings', 'brake_pads', 'brake_rotors',
		'wheels', 'tires', 'sealant', 'valves', 'bar_tape', 'cables',
		'bottom_bracket', 'headset_bearings', 'wheel_bearings', 'cleats', 'other'
	));
