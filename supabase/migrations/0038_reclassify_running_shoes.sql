-- Two pairs of running shoes were imported as kind = 'other'.
--
-- Strava's gear export doesn't always say which of its two gear types a row
-- is, and the importer's fallback is 'other' — correctly, because guessing a
-- kind from a product name is exactly the sort of cleverness that files a bike
-- as shoes. But 'other' is a shrug, and on /activities/gear it puts a pair of
-- running shoes under its own "Other" heading away from the seven other pairs,
-- which is the one place a reader is trying to compare them.
--
-- Confirmed by hand (2026-08-22) rather than inferred: both of these are
-- running shoes.
--
-- Matched on id AND name together. The ids are what actually identify the
-- rows, and the names are the assertion that the ids still mean what they
-- meant when this was written — if an id has since been reused or renamed,
-- this updates nothing rather than reclassifying the wrong piece of gear.
update public.activity_gear
set kind = 'shoes', updated_at = now()
where kind = 'other'
	and (id, name) in (
		(28, 'New Balance FuelCell SuperComp Elite v4 newbs'),
		(35, 'Brooks Ghost 15 Size 11')
	);
