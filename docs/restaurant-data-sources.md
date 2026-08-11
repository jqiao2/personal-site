# Where restaurant and map data come from

The decision, and the constraints that forced it. Written before any of the
restaurant log was built, so the design prompt (`design-prompts/restaurants.md`)
could assume a map we control the look of.

## The decision

**We own the record. Google is a search box and a link. The map is ours.**

| need | source |
| --- | --- |
| Finding a restaurant while logging it | Google Places Autocomplete + Place Details (New), owner-only API route |
| The stored row — name, lat/lng, address, neighborhood, city/state/country, cuisines, price band | **Ours.** Prefilled at log time, confirmed by hand, then never refetched |
| Coordinates | An open geocode (Photon/Nominatim over OSM, or an Overture match), nudged by hand |
| Basemap tiles | Protomaps PMTiles, rendered with MapLibre GL |
| Google Maps link | Built from the stored `place_id` |
| Website / Yelp / Beli links | Typed in by hand |

## Why not just use Google for all of it

Two clauses in the Google Maps Platform terms decide this, and they point the
same way.

**Only `place_id` is storable.** Place IDs are explicitly exempt from the
caching restrictions and can be kept indefinitely. Everything else the Places
API returns — name, coordinates, price level, types — is Places Content under a
caching limit, so a `restaurants` table full of Google-sourced fields is not a
thing we're allowed to keep. That kills the pattern the film log uses, where
`movies` is a durable local cache of TMDB metadata. TMDB's terms permit that;
Google's don't.

**Places content may not be rendered on a non-Google map.** Places API results
displayed on a map have to be displayed on a Google map. So "Google's data on a
basemap styled to look like a taqueria menu" isn't a combination that's
available — it's Google's data on Google's map, or our data on our map.

And a Google basemap can't carry the brief anyway. Cloud-based map styling
adjusts hues and toggles features; it does not get to cream paper with
terracotta roads and hand-set labels. For a site whose entire premise is art
direction, that's the expensive half of the trade, not the cheap one.

## What that costs

Two lookups at log time instead of one: Google for "what is this place
actually called", an open geocoder for a coordinate we're allowed to keep.
Slightly more machinery in the composer, and a pin I confirm by eye rather than
trust blindly. In exchange the database is ours, permanently, and the map is a
style JSON we write.

Google's free tier makes the search side effectively free at personal-diary
volume — Essentials SKUs carry 10,000 free calls a month and a properly
terminated Autocomplete session bills as one request; a few hundred restaurants
a year doesn't approach it. Protomaps is free to self-host (one `.pmtiles`
file) and free on the hosted API for non-commercial use up to a million tile
requests a month.

If we ever want to drop Google entirely, the fallback is Photon (OSM) for the
search box and Overture/FSQ OS Places for POI matching — one fewer vendor, no
key, everything storable forever, at the cost of noticeably worse coverage of
small and newly-opened restaurants. Nothing in the schema depends on Google, by
design: `google_place_id` is nullable and only ever builds a link.

## Attribution

If Places data is shown to a visitor rather than just used to prefill my own
form, Google requires their logo and attribution. We avoid this entirely by
never displaying Places content — it's prefill for a row I then own and edit.
The Google Maps link on a restaurant page is an ordinary outbound link and
carries no such requirement.

## Sources

- [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
- [Places API usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)
- [Autocomplete (New) and session pricing](https://developers.google.com/maps/documentation/places/web-service/session-pricing)
- [Protomaps basemaps for MapLibre](https://docs.protomaps.com/basemaps/maplibre)
- [Overture Maps places guide](https://docs.overturemaps.org/guides/places/)
- [Photon geocoder](https://github.com/komoot/photon)
