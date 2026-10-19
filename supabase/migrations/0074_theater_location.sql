-- Where each theater is, for the /films/stats map of theater viewings.
--
-- Coordinates were looked up on OpenStreetMap (Nominatim) by venue name or
-- street address. A theater left null simply isn't on the map; the composer
-- doesn't geocode new venues, so those get filled here by a later migration.

alter table public.theaters
	add column if not exists lat double precision,
	add column if not exists lng double precision;

update public.theaters t
	set lat = v.lat, lng = v.lng
	from (values
		-- San Diego
		(2,  32.8708, -117.2107),   -- AMC UTC 14 (Westfield UTC)
		(1,  32.8660, -117.2319),   -- AMC La Jolla 12
		(3,  32.7673, -117.1665),   -- AMC Fashion Valley 18
		(4,  32.7676, -117.1483),   -- AMC Mission Valley 20
		(5,  32.6535, -117.0654),   -- AMC Plaza Bonita 14
		(7,  32.9153, -117.1176),   -- AMC Mira Mesa 18
		-- Los Angeles
		(8,  34.0984, -118.2869),   -- Vista Theatre
		-- New York
		(10, 40.7524, -73.9944),    -- AMC 34th Street 14
		(30, 40.7524, -73.9944),
		(9,  40.7750, -73.9817),    -- AMC Lincoln Square 13
		(46, 40.7750, -73.9817),
		(13, 40.7567, -73.9893),    -- AMC Empire 25
		(32, 40.7567, -73.9893),
		(11, 40.7429, -73.9768),    -- AMC Kips Bay 15
		(58, 40.7429, -73.9768),
		(12, 40.7259, -73.9973),    -- Angelika Film Center
		(45, 40.7259, -73.9973),
		(54, 40.7151, -73.9910),    -- Metrograph
		(48, 40.7151, -73.9910),
		(56, 40.6867, -73.9775),    -- BAM Rose Cinemas
		(53, 40.6867, -73.9775),
		(55, 40.6867, -73.9775),
		(51, 40.6867, -73.9775),
		(14, 40.7312, -74.0017),    -- IFC Center
		(17, 40.7741, -73.9801),    -- New Plaza Cinema
		(15, 40.8097, -73.9518),    -- AMC Magic Johnson Harlem 9
		(6,  40.7386, -73.9896),    -- AMC 19th St East 6
		(18, 40.7741, -73.9843),    -- Walter Reade Theater
		(16, 40.7339, -73.9934),    -- Cinema Village
		(19, 40.7562, -73.9240),    -- Redstone Theater (Museum of the Moving Image)
		(25, 40.6906, -73.9832),    -- Alamo Drafthouse Brooklyn
		(38, 40.6617, -73.9799)     -- Nitehawk Prospect Park
	) as v(id, lat, lng)
	where t.id = v.id;
