# 0031 — Putting the schematic subway on a real map

**Type:** strategy
**Applies when:** giving schematic-only data (no lat/lon, no stop ids) real positions, or drawing parallel lines with MapLibre `line-offset`.

## Matching stations without ids
The ArcGIS schematic stations have only name, services and schematic x/y.
`scripts/generate-subway-geo.mjs` matches them to MTA Subway Stations
(data.ny.gov `39hk-dx4f`) by score = name token-Jaccard ×10000 + shared
services ×1500 − metres from an affine-predicted position.

- **The schematic is too distorted for position to lead.** A global affine fit
  (fitted on 400+ exact-name pairs) is still 1–4 km off in Brooklyn and Staten
  Island; with position weighted heavily, half of SIR and the Rockaways matched
  their neighbours. Name must dominate; position only breaks same-name ties
  (the three "145 St"s).
- Normalise abbreviations both ways (Pk/Park, Rd/Road, B'way, E/East, Sts/St).
- Renamed stations whose token overlap is thin (149 St-Grand Concourse →
  149 St-Hostos, President St → …-Medgar Evers College) go in a `RENAMED`
  table. Rerun the script and read its mismatch list after any data change.

## `line-offset` follows line direction
`line-offset` is in screen px (good: the bundle stays a constant width, like
the SVG's hand-rolled trick) but offsets to the line's left/right. A segment
stored a→b and its neighbour b→a land on opposite sides and cross. Orient every
chord into one half-plane before building features.

## Also
data.ny.gov intermittently serves a `healthdata.ny.gov` cert to Node's fetch
(`ERR_TLS_CERT_ALTNAME_INVALID`); just rerun.
