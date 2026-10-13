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
Segments with no real track: 5 Bronx Park East–Morris Park (pure duplicate),
left off via `SKIP`. The generator prints every segment it can't find track for.

Replace a phantom at the source (generate-subway-data.mjs) when the real link
is missing, since the Diagram view draws it too (the map's old `VIA` stand-ins
are gone). Most skip a stop the service makes, so scan for them: any segment
whose polyline passes within 2 units of another station of the same service.
`stopsAt()` fixes that shape (B DeKalb–7 Av, R DeKalb–Union St, A 104 St–
Aqueduct). The others: the R's Canal
St–DeKalb (now Jay St–DeKalb), the M's B'way-Lafayette–Marcy Av that doubled
its Essex St link (now Essex–Marcy), the F's York St links (now
B'way-Lafayette–2 Av). A replaced id in the owner's saved log moves to its
successor on load (`RETIRED` in src/scripts/subway-marks.ts).
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
- **Read left/right once per connected group, not per straight.** Against a
  fixed axis, a winding stretch (DeKalb Av → Atlantic Av) has straights on both
  sides of the axis's perpendicular; read per straight, each curve mirrored the
  B across the bundle and back (+2 → −2 → +0.5 → −1.5 in one segment). Read per
  same-bundle run, a run could vote opposite to the one before and the line
  crossed at the junction. Fix: union-find with parity linking (a) bundle mates,
  (b) a service's same-bundle straights through curves and stations, (c) across
  junctions — skipping any link that contradicts an earlier one — then one
  length-weighted vote per group. Debug by printing a segment's straights:
  `bundle off root` per straight shows a mirror (same bundle, sign flips) vs a
  real rank change (bundle changes, same root).
- **No tiny edges.** Rounding to 5 decimals (~0.85 m) plus cutting pieces at
  inserted points made 0-1 m edges whose direction is noise; `line-offset`
  shoved them sideways as stubs. Line coordinates keep 6 decimals and edges
  inside a piece are ≥ 2 m. Shifts were then drawn in quarter-slot steps, which
  read as a staircase on tight bends (~1.6 px per step at z16). `line-offset`
  is constant per feature, so the fix is steps well under a pixel: 1/16 slot,
  pieces ≥ 2 m, ends snapped to vertices within 1 m (3.7k pieces, 62 KB
  gzipped). The diagram has no such limit: SVG offsets per vertex (`smooth`).
  Short pieces need the GeoJSON source's `tolerance: 0`: by default the tiler
  simplifies per zoom and drops features tiny at that zoom, so zoomed out the
  curves went missing.
- Unridden lines use an **opaque faded colour**, not `line-opacity`: translucent
  pieces darken where their round ends overlap, making the line look dotted.

- **Bundle mates share one centreline.** Slots fan out in pixels from each
  service's own track, so an express a few metres off its local (Lex 4/5 vs 6)
  or the B/D beside the N/Q on the Manhattan Bridge drew over each other close
  in. Each vertex moves to the weighted mean of its bundle mates' tracks (full
  within 30 m, none past 50 m, smoothed over ±60 m), ends at a station together.
- **Cut straights at every line's stations.** An express's straight with no
  stops (B/D 34 St–W 4 St) got one bundle for its whole length, including the
  A/C/E it only meets at the end, and sat half a slot off the F/M — interleaved,
  one thick band. Cutting it where the locals' stations sit gives bundle mates
  the same boundaries; a slot change at a cut eases in like a station.
- **Recut where mates disagree.** A straight can have different mates at each
  end without a station between them: the F from Bergen St runs with the G,
  then beside the A/C into Jay St. Measured whole it counted all three, ranked
  3rd of 4, while the G ranked 2nd of 2, so both landed on the same side. After
  the first membership pass, any mate pair whose bundle sets differ cuts each
  straight where the other's starts/ends, and membership runs again. Cutting
  at *every* curve end (or every mate end) made the map worse: each cut eases
  like a station and adds a slide. Pieces under CHECK m re-sample noisily (a
  75 m stub at Atlantic Av dropped the Q from the B's bundle), so mate cuts
  leave ≥ CHECK m either side. Overlap scan: 3.2 km → 2.4 km.
- **Forced flips land on the line that leaves.** With a fixed order, some
  junctions must cross (E/B/D at 7 Av–53 St). Side links are tried most
  carried-over mates first, so the skipped link — the flip — falls on the line
  leaving its mates (the E, which crosses 6 Av anyway), not between a pair that
  travels on together (the B/D swapped sides there before).
- **A slot change gets at least 80 m.** A one-vertex curve gave a zero-length
  slide: the 1 jumped a slot at a corner near South Ferry. Short curves borrow
  length from the straights either side.
- **Markers sit at the moved line ends,** not the raw platform: the centreline
  pull can move an end tens of metres.
- **Check overlaps by scan, not by eye.** Walk every piece, find parallel pieces
  of other services within 6 m, compare slots read against one fixed direction;
  < 0.75 apart is an overlap. What's left after the fixes is short slides.

## The Diagram view uses the same bundler
`scripts/generate-subway-diagram.mjs` runs `sectionLines` on the schematic
(1 unit = 100 "m"), with three options: `smooth` (per-vertex slots, since SVG
offsets each vertex itself — no quarter-slot staircases), `axis` (left/right per
straight against a fixed SW axis: octilinear track never winds, and the group
vote put the 2/3 across the 1 at Chambers St), and `curveGap` (schematic corner
vertices are ~2 units apart, so the default split corners into fragments). The
schematic's few real gaps (N/Q at Union Sq, Canal St) are welded first; this
replaced the renderer weld and the per-segment `o`.

## `line-offset` follows line direction
It's in screen px (constant bundle width at any zoom), but offsets to the line's
right. Segments are stored a→b or b→a arbitrarily, so a slot must be read
against a shared axis, not the line's own direction (see "Read left/right once
per straight" above), or neighbours land on opposite sides.

## Also
- data.ny.gov intermittently serves a `healthdata.ny.gov` cert to Node's fetch
  (`ERR_TLS_CERT_ALTNAME_INVALID`); the generator retries.
- To debug geometry, plot the generated lines with `svc a-b o=` labels to an SVG
  and screenshot it with Playwright — far faster than reading the map without
  glyphs (the local `.env` has no MapTiler key).
