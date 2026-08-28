-- Bike rides with no GPS are trainer rides.
--
-- The FIT-file path already classifies these (canonical.ts `refineSport`:
-- indoorCycling/virtualActivity -> virtual_ride), but rows that arrived from
-- Strava's label alone kept `ride`, so 168 Zwift sessions sat in the outdoor
-- bucket — wrong on the sport filter, on the heatmap's exclusions and on the
-- card, which asks for a route it will never have.
--
-- "No GPS" is the same predicate the app already uses for it (activities.ts
-- `hasGps`): route_path is null. Multisport legs are left alone; a bike leg
-- of a triathlon is not a trainer ride even if its route didn't record.

update public.activities
set sport = 'virtual_ride'
where sport in ('ride', 'gravel_ride', 'mountain_bike')
  and route_path is null
  and parent_id is null;
