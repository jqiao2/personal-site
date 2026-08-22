-- The Cervélo S3's current parts, from a Strava gear export (2026-08-22).
--
-- WHY EVERYTHING IS FITTED TODAY AND NOT EARLIER. The export carries no install
-- or removal dates at all — it is a parts INVENTORY, not a service log. Since
-- component mileage here is derived from installed_on, any date invented to
-- fill that gap becomes a number the page then states as fact: dating this
-- chain to the bike's first ride (2020-04-04) would credit it with 18,106
-- miles, seven chains' worth, drawn as a wear bar and labelled overdue. So
-- tracking starts today, every figure above it is true from this point on, and
-- the real install dates can be set by hand as they're remembered.
--
-- WHY THE SUPERSEDED PARTS ARE NOT HERE. The export lists three chains, three
-- front brake pads, three rear tires and two wheelsets on this bike — a
-- history, but an undated one. Loading them as closed rows would put seven
-- parts in the service history each reading 0 miles over 0 days, which is not
-- a record of anything. They are dropped rather than faked; the export file
-- itself is the archive if the part names are ever wanted.
--
-- WHY THE LAST ROW OF EACH TYPE IS THE CURRENT ONE. Confirmed by hand, not
-- inferred from the file's order.
--
-- MAPPING NOTES. Frames are skipped: a frame is not a wear item, and the bike
-- row already is the frame. Wheelsets map to `wheel_bearings` — the wheel
-- itself doesn't wear out, its bearings do, and that is the tracked kind the
-- part actually belongs to. Pedals have no kind in COMPONENT_KINDS (the tracked
-- contact-point part is `cleats`, which lives on shoes) so they take `other`.

insert into public.gear_components (gear_id, kind, label, installed_on)
select g.id, v.kind, v.label, date '2026-08-22'
from public.activity_gear g
cross join (values
	('chain',          'Shimano Ultegra/XT CN-HG701 11-speed (waxed)'),
	('cassette',       'Shimano Ultegra CS-R8000 11-speed'),
	('brake_pads',     'Front — Shimano L05A-RF resin disc'),
	('brake_pads',     'Rear — Shimano L05A-RF resin disc'),
	('brake_rotors',   'Front — Shimano Ultegra RT-CL800'),
	('brake_rotors',   'Rear — Shimano Ultegra RT-CL800'),
	('tires',          'Front — Continental GP5000 AS TR 28mm'),
	('tires',          'Rear — Continental GP5000 AS TR 28mm'),
	('wheel_bearings', 'Front — HUNT 44 Aerodynamicist Carbon Disc'),
	('wheel_bearings', 'Rear — HUNT 54 Aerodynamicist Carbon Disc'),
	('cables',         'Rear shifter cable'),
	('other',          'Pedals — Garmin Rally RS100')
) as v(kind, label)
where g.id = 25
	and g.name = 'Cervélo S3'
	-- Idempotent: re-running this adds nothing. The guard is per (gear, kind,
	-- label) rather than a blanket "has any components", so a later hand-added
	-- part can't make this migration silently skip the rest of the set.
	and not exists (
		select 1 from public.gear_components c
		where c.gear_id = g.id and c.kind = v.kind and c.label = v.label
	);
