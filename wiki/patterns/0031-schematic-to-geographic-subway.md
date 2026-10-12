# 0031 — Putting the schematic subway on real track

**Type:** strategy
**Applies when:** giving schematic-only data (no lat/lon, no stop ids) real geography, slicing GTFS shapes, or fanning parallel lines with MapLibre `line-offset`.

`scripts/generate-subway-geo.mjs` turns `subway-data.js` (the ArcGIS schematic)
into `subway-geo.js`: real track per segment, a marker per platform, and a
side-by-side slot per segment. Same station/segment ids, so the saved log works
in both views.

## Straight chords look bad — slice GTFS shapes instead
The first cut drew station-to-station chords; it was rejected on sight. MTA GTFS
`shapes.txt` has every service variant's drawn path. Slice the service's shape
between the projections of its two stops (pick the shortest valid slice; reject
slices > 2.5× the direct distance, which went round a loop). Douglas–Peucker at
2 m keeps curves in ~130 KB.

## Match each segment end to the stop that service *really* calls at
Name matching alone puts a schematic "Fulton St" or "Wall St" on another line's
platform, and the slice then starts 200 m off — stubs and gaps everywhere.
`stop_times` + `trips` give route → stops served. Per (station, service) pick the
nearest stop by `distance − 300·nameSim + (not served by this route ? 500 : 0)`.
The penalty must outweigh a complex's spread (~250 m at Fulton St) yet let a
renamed/rerouted service borrow a platform (the feed is *this week's* service:
the M was on 63 St, not 53 St). Pin both slice ends to the platform itself so
every service meeting there touches it. W and Z have stops but no shapes: borrow
the shape of any route serving both stops.

## The schematic has phantom links
Segments with no real track: A 104 St–Aqueduct (stands in for the missing
Rockaway Blvd–104 St), R Canal St–DeKalb (for Jay St–DeKalb), 5 Bronx Park
East–Morris Park (pure duplicate). The generator prints every segment it can't
find track for; route stand-ins via `VIA`, leave pure phantoms off via `SKIP`.
Also check the longest track/direct ratios — a 5 km R "segment" was the clue.

## Bundles: per straight, shift inside curves (`scripts/subway-bundles.mjs`)
A slot that is fixed per segment can only change at a station, as a hard sideways
step. Sampling every 10-20 m and smoothing worked but was noisy and heavy. What
stuck (the user's design): split each line into **straights and curves** (a run
of >4° vertices totalling ≥15°), give each straight one slot, and **interpolate
the slot through the curve** — the 2/5 slide together as they bend off the 3/4
at Franklin Av. At a station a service's two segments ease to the average of
their slots over ~80 m. Interpolated stretches are 1/16-slot constant pieces
(`line-offset` is per feature); pieces share the segment id, so feature-state
and clicks still treat them as one line.

- **Keep the global service order.** The user rejected re-ordering bundles to
  minimise crossings; slots are the rank by `SERVICES` order.
- **Shared = ≤15 m parallel, or ≤45 m truly parallel (|cos| > 0.97).** 15 m
  alone left side-by-side tunnels (2/3 vs 4/5 at Borough Hall, A/C/F vs R at Jay
  St) as separate bundles drawn over each other. 45 m with the loose angle pulled
  Broadway into the 7 Av bundle where it converges at ~25° above Times Sq.
- **Record membership from both sides.** If straight X sees service S alongside,
  the straights of S it saw count X back. One-sided detection left the A/C/E and
  B/D/F/M through W 4 St each thinking they had the track, overlapping.
- **Read left/right once per straight**, against an axis chosen where the least
  straight track runs perpendicular. Per-sample readings flipped back and forth
  on Queens Blvd curves.
- Unridden lines use an **opaque faded colour**, not `line-opacity`: translucent
  pieces darken where their round ends overlap, making the line look dotted.

## `line-offset` follows line direction
It's in screen px (constant bundle width at any zoom), but offsets to the line's
left. Store every line heading east-or-north at its midpoint, or a→b and b→a
neighbours land on opposite sides.

## Also
- data.ny.gov intermittently serves a `healthdata.ny.gov` cert to Node's fetch
  (`ERR_TLS_CERT_ALTNAME_INVALID`); the generator retries.
- To debug geometry, plot the generated lines with `svc a-b o=` labels to an SVG
  and screenshot it with Playwright — far faster than reading the map without
  glyphs (the local `.env` has no MapTiler key).
