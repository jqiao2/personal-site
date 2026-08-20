# Where a place is

The location half of a `restaurants` row, defined field by field.

**Status: shipped.** Migration `0033_place_location_detail.sql` is applied, the
`??` chains in `geocode.ts` are rewritten, `reverseGeocode()` exists, and the
333 placed restaurants have been backfilled. The audit below is kept as written
— it is the record of what was wrong and why each column earns its place.

The original finding: of the ten things below, five were stored, one was
derivable but unreachable, and four did not exist — the street address, OSM's
own identity, the quarter, and the borough. The last two were missing in the
specific sense that OSM *returned* them and `toHit()` threw them away.

There was also one hole that was not a field at all: **nothing reverse-geocoded.**
`geocode.ts` called Nominatim's `/search` and nothing called `/reverse`, so
"querying OSM given a plus code" was a two-step trip the code could not make.

> **One thing the audit got wrong, corrected by asking Nominatim.** This document
> first claimed NYC boroughs arrive as `city_district`. They do not. A real
> reverse geocode of a Sunset Park address returns
> `{ neighbourhood: "Sunset Park", suburb: "Brooklyn", city: "New York" }` — no
> `city_district` at all. The borough is in `suburb`, which elsewhere in the
> world is routinely the neighbourhood. The rule that fits both is in
> [`splitAddress`](../../src/lib/geocode.ts): the keys are two tiers, finest
> first, so when both appear the second is the borough, and when only `suburb`
> appears it is the neighbourhood.

---

## The fields

### 1. Coordinates — `lat`, `lng`

The point, as two decimals. WGS 84, the only datum involved anywhere here.

Stored on the place, never on the visit: a restaurant does not move between
meals. Nullable, because a place can be logged before it is placed, and an
unplaced place is a normal row rather than a broken one.

The rule that makes this column trustworthy is not the range check, it is
`precise` in `geocode.ts`: a result under `place_rank` 30, or of category
`boundary`, is an *area*, and the centroid of an area must never be written
here. A pin on a door is worth having; a pin floating in the middle of Sunset
Park is worse than no pin, because nobody goes looking for it.

**Today: present and correct.** `double precision`, range-checked, nullable,
with the centroid guard already in place.

### 2. Plus code — derived, not stored

The Open Location Code for the point. `87G8Q2MM+2C`.

It is a **pure function of `lat`/`lng`** and carries no information they do not
already carry, so it gets no column. Storing it would create a second copy of
the coordinates that can disagree with the first, which is the only way this
field can ever be wrong.

Its job is input and display, not storage: it is how a place that exists in no
database gets placed at all, and it is the one form of a location a human can
read off a phone screen and type in.

**Today: half there.** `src/lib/plus-code.ts` is a complete, correct OLC
implementation — full codes, short codes, recovery against a reference, the
5×4 grid handled properly. But it is **input-only**. A pasted code is decoded to
`lat`/`lng` and the code itself is discarded, and `encode()` is not exported, so
nothing on the site can render a plus code for a place it already knows the
coordinates of.

**Fix: export `encode()`.** One word. No column, no migration, no backfill.

### 3. OSM's geocoding — `osm_type`, `osm_id`

OpenStreetMap's own handle on the object: `node/1234567`, `way/89012345`.
Together they are the stable identity of the thing that was matched.

This is the field that makes the geocode auditable rather than a rumour. With
it you can re-query the object years later, see whether it moved or closed,
carry the ODbL attribution the licence asks for, and tell "I confirmed this
against OSM" apart from "I typed these numbers in myself". Without it, a
coordinate on a row is an assertion with no provenance.

Worth storing alongside: `place_rank` (the number `precise` is computed from —
keeping it means the judgement can be re-made later without re-fetching) and
`display_name` (Nominatim's full rendered line, which is what disambiguates two
hits with the same name).

**Today: missing, and deliberately so far.** `NominatimRow` in `geocode.ts` does
not even declare `osm_id` — the field arrives in the response and is dropped at
the type boundary. `place_sources` can hold a row with `source = 'osm'` and that
dataset's `source_id`, but that table is **intentionally not joined** to
`restaurants` ("the moment a suggestion is accepted its values are copied, not
referenced"), so the link is severed at exactly the moment it would become
useful. Copying the values is right. Dropping the identity with them is the
part that costs something.

### 4. Street address — `house_number`, `road`

The street line. `83`, `Elizabeth Street`.

Two columns rather than one, because they are two facts and they are used
apart: the road alone is the useful thing when the number is unknown (carts,
stalls, food halls), and a number without a road is meaningless. The rendered
one-line form is a `join`, not a column.

**Today: missing entirely.** There is no address column on `restaurants` at all.
`GeocodeHit.address` is *computed* in `toHit()` from `house_number` and `road`,
shown in the picker so you can tell two hits apart — and then thrown away when
you pick one. `place_sources.address` exists, but only for candidates, and never
crosses over. So the log knows a restaurant is at a point and does not know what
street it is on.

This is the largest of the four gaps, because the address is the one location
fact that a coordinate cannot reconstruct and a human cannot eyeball.

### 5. Neighborhood — `neighborhood`

The name a local would use. Sunset Park, Astoria, the Mission.

Nullable and null a lot, by design: strongly present in New York, largely absent
everywhere else, and absent means "the city is the right granularity for this
place", not "a field is missing". That reading is correct and should survive
any revamp.

**Today: present, but lossy.** `toHit()` collapses three distinct OSM keys into
this one column:

```ts
const neighborhood = a.neighbourhood ?? a.suburb ?? a.quarter ?? null;
```

So a quarter that OSM returned as a quarter is stored as a neighbourhood, and
whichever of the three won is unrecoverable afterwards. This is also where the
known wrong answers come from — Ba Xuyên landing in "Dyker Heights" when anyone
who lives there says Sunset Park is `suburb` beating the truth.

### 6. Quarter — `quarter`

OSM's `quarter`: a subdivision below the neighbourhood, common in European and
Asian addressing and rare in the US.

Its own column, not a fallback for the one above. The whole reason the current
`??` chain is lossy is that it treats three different levels as
interchangeable, and the fix is to stop doing that, not to reorder them.

**Today: missing as a field.** Read from OSM, then flattened into
`neighborhood` by the chain above.

### 7. Borough — `borough`

The administrative tier between neighbourhood and city. In New York this is
Brooklyn, Queens, Manhattan, the Bronx, Staten Island.

This is the one that is not merely missing but actively mishandled, and it is
worth being precise about why. Nominatim returns NYC boroughs as
**`city_district`** (sometimes `suburb`). The current mapping is:

```ts
const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null;
```

`a.city` for anywhere in the five boroughs is `"New York"`. `city_district` is
`"Brooklyn"` — and it is **never read**. So the borough either falls through to
`neighborhood` via `suburb`, or vanishes.

That is a real problem for this log specifically, because the borough is the
unit New York is actually discussed in. `restaurants.ts:439` renders
`neighborhood ?? city` as a group title, which means every Brooklyn place either
groups under its neighbourhood or under "New York", and there is no way to ask
for Brooklyn.

Outside New York it should be null far more often than not. It is not a
required tier; it is a tier that some cities have.

### 8. City — `city`

The municipality. `not null` — every place is in one, even if the name is a
best guess.

**Today: present.** Correctly maps `city ?? town ?? village ?? municipality`.
The `?? county` at the end of that chain is a stretch — a county is not a city —
but it is a reasonable last resort for rural places, and it is a smaller problem
than the borough one above.

### 9. State / province — `state_region`

The first-level administrative division. New York, Texas, Ontario, Bavaria.

One column for all of them, deliberately: the distinction between a state, a
province, a region and a prefecture is not one this log will ever act on, and
three nullable columns to preserve a distinction nothing reads is the kind of
fidelity that costs and returns nothing.

**Today: present and correct.** Maps `state ?? province ?? region`.

### 10. Country — `country`

ISO 3166-1 alpha-2, upper-cased. `US`, `JP`, `MX`.

A code rather than a name, because names are ambiguous and localised and codes
are neither. `not null default 'US'`.

**Today: present and correct.** `geocode.ts` already upper-cases
`address.country_code` into exactly this shape.

---

## The audit, in one table

| Field | Column | Status |
|---|---|---|
| Coordinates | `lat`, `lng` | **Present.** Range-checked, nullable, centroid guard works |
| Plus code | *(derived)* | **Half.** Full OLC lib exists, input-only, `encode()` not exported |
| OSM identity | `osm_type`, `osm_id` | **Missing.** Not even declared on `NominatimRow` |
| Street address | `house_number`, `road` | **Missing.** Computed for display, then discarded |
| Neighborhood | `neighborhood` | **Present, lossy.** Absorbs suburb and quarter |
| Quarter | `quarter` | **Missing.** Flattened into `neighborhood` |
| Borough | `borough` | **Missing.** OSM's `city_district` never read |
| City | `city` | **Present.** `?? county` is a stretch |
| State / province | `state_region` | **Present.** |
| Country | `country` | **Present.** ISO alpha-2, correct |

Five present, one half, four missing.

---

## The two changes that are not columns

Adding columns is the easy half and it is not the half that makes this work.

**Reverse geocoding does not exist.** `geocode.ts` hits `/search` only. So the
brief's "query OSM given a plus code" is currently impossible: a plus code
decodes to coordinates by arithmetic — no network, no lookup — and then the trip
stops. Place a restaurant by plus code today and it gets a point and **no
administrative fields whatsoever**; `PlaceEditor` sets `state.coords` and
nothing else, and the neighbourhood and city come from whatever you typed in the
"where" box. Filling the hierarchy from a plus code needs a
`/reverse?lat=&lon=&addressdetails=1` call that nothing currently makes.

It belongs in the same file, behind the same pacing and the same User-Agent —
the one-request-a-second budget is per service, not per endpoint, and
`geocode.ts` already owns that budget.

**The `??` chains are the bug.** Every "missing" field above except the address
and the OSM identity is missing because `toHit()` collapses a hierarchy into
three columns. Widening the table without widening `toHit()` changes nothing:
the new columns would sit empty while the old ones stay lossy. The mapping to
write is one OSM key to one field, no fallbacks between tiers:

| Field | OSM key |
|---|---|
| `house_number` | `house_number` |
| `road` | `road ?? pedestrian ?? footway` |
| `neighborhood` | `neighbourhood ?? suburb` |
| `quarter` | `quarter` |
| `borough` | `city_district ?? borough ?? suburb`, the last only when `neighbourhood` is also present |
| `city` | `city ?? town ?? village ?? municipality` |
| `state_region` | `state ?? province ?? region` |
| `country` | `country_code`, upper-cased |

Fallbacks *within* a tier are fine — `town` really is the city of a town. What
has to stop is fallbacks *across* tiers, which is what turns a quarter into a
neighbourhood and loses a borough.

`county` appears in no chain. The Sunset Park lookup reports "Kings County",
which is a true fact about Brooklyn and not a field this log has; the old city
chain ended in `?? county`, which would have quietly named a county as a city
for any rural place. That tail is gone.

---

## What shipped

1. **`encode()` exported** from `plus-code.ts`. One word; the plus code is
   readable everywhere without storing anything.
2. **Migration `0033`** — seven nullable columns on `restaurants`: `osm_type`,
   `osm_id`, `place_rank`, `house_number`, `road`, `quarter`, `borough`. Both
   views rebuilt, because `restaurant_places` selects `r.*` and `create or
   replace view` cannot add columns in the middle — the same trap `0031`
   documented.
3. **`splitAddress()`** replaces the `??` chains, one key to one field, and is
   exported so it can be tested without a network.
4. **`reverseGeocode(lat, lng)`** in `geocode.ts`, sharing the existing pacer
   and User-Agent, behind `/api/restaurants/reverse`.
5. **The write path widened** — `PlaceInput`, `placePayload`, `POST`, `PATCH`,
   and `PlaceEditor`, whose four separate coordinate-setting sites now funnel
   through one `placeAt()` that settles the point and then goes and finds out
   what is there.
6. **Backfilled** — `scripts/backfill-place-location.mjs`, one reverse geocode
   per placed restaurant at one request a second, writing only into columns
   that are null.

### The one thing the backfill deliberately does not write

`osm_type`/`osm_id`/`place_rank` are **not** backfilled, and this is the most
important line in the script. Reverse geocoding returns whatever object sits
nearest the point: asked about a Sunset Park restaurant's pin, Nominatim answers
`node/2561552351`, which is *a nail salon two doors down*. That is a fine answer
to "what is at these coordinates" and a wrong answer to "which OSM object is
this restaurant", and writing it into `osm_id` would manufacture exactly the
false provenance the column exists to prevent.

The address tiers do not have that problem — the nail salon and the restaurant
share a street, a neighbourhood and a borough — which is precisely why those are
safe to read off a neighbour and an identity is not.

So the OSM identity is only ever recorded going forward, when a **named** hit is
picked in the composer and the match is a name match rather than a proximity
one. `PlaceEditor`'s by-hand branch does not set it either, for the same reason.

### A gazetteer conflation fixed on the way

`place-lookup.ts` mapped `place_sources.locality` to `neighborhood`. For DOHMH
rows — the bulk of the gazetteer — `locality` is the health department's `BORO`
column, holding literally "Brooklyn", "Queens", "Bronx", "Staten Island". It was
the same borough-into-neighbourhood conflation arriving from the other source,
and it now maps to `borough`, with `neighborhood` left null because for those
rows it is genuinely unknown.

## What this deliberately does not ask for

**No `address` text column.** The rendered line is `[house_number, road]`
joined, and a stored copy of a join is a second thing to keep in sync.

**No PostGIS.** The queries are a box filter and a distance sort over a personal
list; two btrees already answer that, and `0032` says so.

**No foreign key from `restaurants` to `place_sources`.** The existing rule —
values are copied, not referenced — is right, and `osm_type`/`osm_id` on the
restaurant row is the provenance that was actually missing.

**No separate `province` / `region` columns.** `state_region` is one field on
purpose.
