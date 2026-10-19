-- The two venues 0074 couldn't place.

update public.theaters t
	set lat = v.lat, lng = v.lng
	from (values
		-- Seventh Heaven Bar & Karaoke, 4 Irving Ave, Bushwick
		(57, 40.7054, -73.9259),
		(49, 40.7054, -73.9259),
		(42, 40.7054, -73.9259),
		-- Central Park Film Festival: the lawn behind Le Pain Quotidien, west of
		-- the skaters' circle (40°46'24.3"N 73°58'24.5"W)
		(44, 40.7734, -73.9735)
	) as v(id, lat, lng)
	where t.id = v.id;
