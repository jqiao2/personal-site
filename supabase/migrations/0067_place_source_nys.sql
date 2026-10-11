-- A fifth gazetteer source: New York State Agriculture & Markets' licensed
-- retail food stores (data.ny.gov 9a8c-vfzj).
--
-- Plenty of bagel shops, delis and 24-hour counters in the city hold a state
-- retail-food licence rather than a DOHMH restaurant permit, so the health
-- department's list never has them. See wiki/patterns/0028.
alter table public.place_sources drop constraint place_sources_source_check;

alter table public.place_sources
	add constraint place_sources_source_check
	check (source in ('dohmh', 'overture', 'foursquare', 'osm', 'nys'));
