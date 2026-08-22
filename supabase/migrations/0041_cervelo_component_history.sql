-- The Cervélo's real service history, from Strava's component page (the dated
-- view, not the export CSV that 0039 had to work from).
--
-- 0039 fitted all twelve current parts "today" because the export carried no
-- dates and inventing them would have printed fiction as fact. These are the
-- dates, so this corrects the twelve and adds the ten parts that came off.
--
-- "Since Beginning" in Strava means the bike's first recorded ride, which for
-- this frame is 2020-04-04. It is written out as that date rather than left as
-- a sentinel: the wear window is arithmetic on a date, and "the beginning" is
-- only a date if you say which one.
--
-- THE MILEAGE IS NOT COPIED. Strava's column ("2,755.8 mi" on the old chain) is
-- its own sum over its own idea of which rides count. Writing those figures
-- into baseline_distance_m would freeze a second, disagreeing total next to the
-- one this site derives from the activities — the exact two-sources-of-truth
-- problem the whole design refuses. The dates are what Strava knows and this
-- database doesn't; the miles it can work out itself.
--
-- TWO THINGS IN THE SOURCE DATA ARE ODD AND ARE LOADED AS-IS. There is no chain
-- on the bike between 2024-11-13 and 2026-02-20, and the chain fitted
-- 2026-08-01 overlaps the one removed 2026-08-19 by eighteen days. Both are
-- what Strava holds. Straightening them here would be inventing a service
-- history to make a page look tidy, which is worse than a page that shows a
-- gap honestly.

-- ---------------------------------------------------------------------------
-- 1. The wheelsets are wheels, not the bearings inside them (0040).
-- ---------------------------------------------------------------------------
update public.gear_components
set kind = 'wheels', updated_at = now()
where gear_id = 25
	and kind = 'wheel_bearings'
	and label in (
		'Front — HUNT 44 Aerodynamicist Carbon Disc',
		'Rear — HUNT 54 Aerodynamicist Carbon Disc'
	);

-- ---------------------------------------------------------------------------
-- 2. The twelve fitted parts get their real install dates.
-- ---------------------------------------------------------------------------
-- Matched on label with `removed_on is null`, so once the history below is
-- loaded — where two pairs of brake pads and two rear tires carry the same
-- label as the parts that replaced them — this still only touches the current
-- one.
update public.gear_components c
set installed_on = v.installed_on, updated_at = now()
from (values
	('Shimano Ultegra/XT CN-HG701 11-speed (waxed)', date '2026-08-01'),
	('Shimano Ultegra CS-R8000 11-speed',           date '2024-11-19'),
	('Front — Shimano L05A-RF resin disc',          date '2026-05-07'),
	('Rear — Shimano L05A-RF resin disc',           date '2026-05-07'),
	('Front — Shimano Ultegra RT-CL800',            date '2024-11-19'),
	('Rear — Shimano Ultegra RT-CL800',             date '2024-11-19'),
	('Front — Continental GP5000 AS TR 28mm',       date '2026-05-08'),
	('Rear — Continental GP5000 AS TR 28mm',        date '2026-08-19'),
	('Front — HUNT 44 Aerodynamicist Carbon Disc',  date '2024-11-19'),
	('Rear — HUNT 54 Aerodynamicist Carbon Disc',   date '2024-11-19'),
	('Rear shifter cable',                          date '2026-03-27'),
	('Pedals — Garmin Rally RS100',                 date '2022-05-27')
) as v(label, installed_on)
where c.gear_id = 25
	and c.removed_on is null
	and c.label = v.label;

-- ---------------------------------------------------------------------------
-- 3. The ten parts that came off.
-- ---------------------------------------------------------------------------
-- Idempotent on (gear, kind, label, installed_on) — the install date has to be
-- part of the key here, because a replacement pad is the same kind and the same
-- label as the pad it replaced. That is not a collision, it is the point: the
-- history is the same part fitted twice, and the dates are what tell them apart.
insert into public.gear_components (gear_id, kind, label, installed_on, removed_on)
select 25, v.kind, v.label, v.installed_on, v.removed_on
from (values
	('chain',      'Shimano Ultegra/XT CN-HG701 11-speed',                date '2022-10-05', date '2024-11-13'),
	('chain',      'Shimano Ultegra/XT CN-HG701 11-speed',                date '2026-02-20', date '2026-08-19'),
	-- Brand never recorded; the label says which side and nothing it doesn't know.
	('brake_pads', 'Front',                                               date '2022-01-12', date '2024-11-13'),
	('brake_pads', 'Front — Shimano L05A-RF resin disc',                  date '2024-11-19', date '2026-05-15'),
	('brake_pads', 'Rear — Shimano L05A-RF resin disc',                   date '2024-11-19', date '2026-05-15'),
	('wheels',     'Front — DT Swiss E 1800 Spline',                      date '2020-04-04', date '2024-11-20'),
	('wheels',     'Rear — DT Swiss E 1800 Spline',                       date '2020-04-04', date '2024-11-20'),
	('tires',      'Front — Continental GP5000 S TR TdF Limited Edition', date '2024-11-16', date '2026-05-15'),
	('tires',      'Rear — Continental GP5000 S TR TdF Limited Edition',  date '2024-11-16', date '2026-05-15'),
	('tires',      'Rear — Continental GP5000 AS TR 28mm',                date '2026-05-08', date '2026-08-19')
) as v(kind, label, installed_on, removed_on)
where not exists (
	select 1 from public.gear_components c
	where c.gear_id = 25
		and c.kind = v.kind
		and c.label = v.label
		and c.installed_on = v.installed_on
);
