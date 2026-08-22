# The activity log

## Where this is up to

Built so far, on `claude/strava-activities-feature-26rgcy` (PR #115):

| Piece | State |
| --- | --- |
| `0034_activity_log.sql` | **Applied** to the live project. All six tables and the three views exist; every table is empty. |
| `src/lib/activities.ts` | Query layer over the schema. Untested against real rows. |
| `src/lib/exertion.ts` | The §3 cascade. Anchors verified: an hour at FTP scores 100.00; 4h at 0.65 IF scores 169.00; a hike with no thresholds falls to the MET floor. |
| `src/lib/route-shape.ts` | Polyline codec, mercator, RDP simplify, the §7 `routePath` pipeline. |
| `src/lib/sports.ts` | 23 sport slugs, per-sport stat ordering, per-sport glyphs. |
| `ActivityLayout` + `activity-tokens` + `ActivityCard` | The alpine shell and the route poster, all three sizes. Looked at and iterated on. |
| `nav.ts` | `Activities` added. |
| `/activities` | **Placeholder** — hardcoded fixtures, no database. Proves the shell and the card. |
| `src/lib/ingest/**` | **Built.** §4's canonical pipeline: `canonical.ts`, `fit.ts`, `gpx.ts` (GPX + TCX), `strava-archive.ts`. |
| `scripts/import-strava-archive.mjs` | **Built**, and dry-run against the real export: 1773 activities parsed in 80s. |
| `scripts/ingest.test.mjs` | The checks for what fails silently. `npm run activities:test`. |

Not built yet: the real landing page, `/activities/all`, the detail page, the
month in review, §4's file-drop endpoint (step 2) and the OAuth providers
(step 3).

### The importer

```
npm run activities:import -- <archive-dir> [--dry] [--limit N] [--rest-hr N]
```

It runs locally on purpose — the archive is hundreds of megabytes and every
outdoor track starts at the athlete's front door, so only derived rows leave
the machine. Re-running is safe: each activity carries an `activity_sources`
row with a uniquely-indexed Strava id, and the script skips what it already
imported, so an interrupted run resumes.

**Plain-node scripts can import the site's own TypeScript** via
`--import ./scripts/ts-hook.mjs` (eleven lines, no dependency). Use it rather
than reimplementing §3 or §7 in a script — `scripts/seed-activities.mjs`
carries its own copy of the §7 route pipeline and that is the thing to avoid
repeating.

### What the real archive turned out to contain

- **1751 files: 1303 FIT, 270 GPX, 177 TCX**, mostly gzipped. All three
  parsers are needed; FIT covers everything recent.
- `activities.csv` has **103 columns and repeats four names** — `Elapsed
  Time`, `Distance`, `Max Heart Rate`, `Relative Effort`. The first of each
  pair is Strava's rounded display copy (distance in **km**), the second the
  precise one (**metres**). Address columns by index, not name.
- **The athlete moved.** Recorded UTC offsets run −7/−8 through 2024 and −4/−5
  from 2025. §2's "alpine, PNW" art direction and the Seattle place names in
  the seed script are now a description of the older half of the history.
- **FTP comes from the athlete's TrainerRoad history**, not from the archive.
  FIT sessions do carry the FTP configured on the head unit (540 readings), but
  it is stale, disagrees between units, and is mostly auto-detected — raw it
  gives 230 → 200 → 240 inside eight days. The real list is 22 dated entries
  from 2016 to 2026, several of them ramp tests, and it lives in
  `TRAINERROAD_FTP` in the importer. The device readings are kept only as the
  fallback path.

- **Eight recordings back more than one csv row**, and both kinds were silently
  wrong until §4's dedupe was actually built:
  - **Six split rides.** One upload renamed into two or three Strava
    activities ("Ride from DR" / "Ride to DR"), each carrying the *whole*
    ride's distance and power. Stored as one activity with every Strava id
    kept in `activity_sources`.
  - **Two triathlons.** A multisport FIT file holds one session per leg, and
    the export copies that same file once per leg under a different filename.
    Reading `sessionMesgs[0]` gave all five legs the swim's numbers. Now
    parsed per session into a `triathlon` parent with its legs as children —
    the first thing to use §5's `parent_id`/`leg`.

**Streams are stored whole**, at whatever rate the device recorded. Only float
noise is trimmed, at each sensor's real precision (lat/lng 6dp ≈ 11cm). The
detail page must pick its own display resolution — storage keeps the truth.
Budget: ~37 bytes per sample on disk, so the full history is ~230MB of streams
against a 500MB free-tier database that already holds 160MB of films and books.

**Running power is not cycling power.** §3's top rung divides normalized power
by FTP, and both are cycling quantities — but a running watch reports watts
too, on a different scale. Ungated, this athlete's runs scored an average of
187 TSS (max 971) where an hour at threshold is 100. `exertion.ts` now gates
that rung on the bike family. If a running-power model is ever wanted, it needs
its own threshold and its own rung, not this one.

**A placeholder `.env` may be present.** A remote session created one with fake
Supabase values so `astro.config.mjs` (which hard-requires `SUPABASE_URL`) would
load. It is git-ignored and holds no real credentials, but anything run as
`node --env-file=.env` against it will silently talk to nothing. Check `.env`
points at the real project before seeding or importing.

---

The fourth section of the family. The film log models the owner's relationship
to a MOVIE, the book log to a BOOK, the restaurant log to a PLACE YOU EAT — this
one models **a thing the body did**, and it is the first section whose records
arrive from machines rather than from typing.

That difference decides most of the design:

- **The record is not authored, it is ingested.** A watch is a sentence you
  wrote; a ride is four hours of samples a head unit recorded. So the schema has
  a provenance layer (which device, which file, which external id) that the
  siblings don't need, and the owner's own writing (a title, a note) is a thin
  editorial layer on top of machine truth.
- **The same ride can arrive three times.** Wahoo records it, Strava mirrors it,
  Garmin Connect syncs it. Deduplication is a first-class concern, not a
  cleanup script.
- **Not every activity has a route.** A pool swim, a trainer ride and a
  treadmill run have no GPS at all, and that is a normal reading rather than a
  gap. Anything that draws a route must have a designed answer for its absence.
- **Activities are not comparable by any one number.** A 4-hour endurance ride,
  a 40-minute threshold run and a 90-minute hike are three different kinds of
  hard. `exertion` is this section's attempt at one axis they can all be sorted
  on, and it is honest about how it got there — see below.

---

## 1. Routes and pages

| Path | What it is |
| --- | --- |
| `/activities` | Landing. Top-four favourites, then a reverse-chronological Mon–Sun **week** calendar; each day is a vertical list of that day's activities. |
| `/activities/all` | Every activity, reverse chronological, with filters and sorts. |
| `/activities/[id]` | One activity. Interactive map first; the stats shown depend on the sport. |
| `/activities/month` | Index of months. |
| `/activities/month/[month]` | The month in activities — a share card, same family as `/films/month/[month]`. |
| `/activities/import` | Owner-only. Strava archive import + file drop. |
| `/api/activities/**` | Reads and writes. Reads public, writes owner-only. |

`Activities` is added to `NAV_LINKS` in `src/lib/nav.ts`, after `Restaurants`.

---

## 2. Art direction — alpine, PNW

Not the film log's dark warm room and not the restaurant log's cream paper. This
is **a clear day above the treeline**: cold light, a lot of white space, one
saturated blue that only the water and the route line are allowed to use.

### Palette (`src/lib/activity-tokens.ts`)

```ts
export const ALPINE = {
  sky:        '#dceaf4', // the page's ground — a washed high-altitude blue-white
  skyDeep:    '#9fc4dd', // the gradient's far end, top of frame
  snow:       '#f8fbfd', // cards, the paper things are printed on
  granite:    '#3d4a55', // body text, the rock the whole palette is built on
  graniteSoft:'#6b7b88', // secondary text, axis labels, the "off" state
  lake:       '#1c6e8c', // THE accent. Route lines, links, active states.
  lakeDeep:   '#12495e', // hover/pressed, and the deep end of a gradient
  glacier:    '#8fd0d8', // a second cold tone: water fills, swim sports
  fir:        '#3f6b52', // subalpine fir — hikes, trails, elevation fills
  larch:      '#d99a3a', // the one warm note. Autumn larch. PRs, favourites, peaks.
  scree:      '#c9d4dc', // hairlines, borders, empty grid cells
  alpenglow:  '#c96f5e', // reserved for maximum-exertion marks only
} as const;
```

Rules that keep it from turning into a dashboard:

- **One saturated thing per view.** On the landing page it's the route lines. On
  the detail page it's the map's route. Everything else is granite on snow.
- **No coloured chips per sport.** Sport is said with a mark (an icon) and a
  word, not with twelve hues. The palette above assigns colour to *meaning*
  (water, land, effort), not to taxonomy.
- **Elevation is drawn as terrain, not as a chart.** Area fills, not lines, in
  `fir` over `scree`.
- **Numbers are tabular.** `font-variant-numeric: tabular-nums` everywhere a
  figure sits in a column.

### Type

Google Fonts, loaded in `ActivityLayout.astro` the way `FilmLayout.astro` loads
Archivo/Newsreader:

- Display / headings: **Instrument Serif** — high contrast, thin, reads as crisp
  air rather than as a magazine.
- UI, stats, everything else: **Instrument Sans**, with tabular numerals.

### Shell

`src/layouts/ActivityLayout.astro` — light body (`sky` → `snow` vertical wash),
`granite` text, the same `a.back` history handling as `FilmLayout`.

---

## 3. Physical exertion — the one comparable axis

### What the literature actually offers

| Method | Needs | Good for |
| --- | --- | --- |
| **TSS** (Coggan) | power stream + FTP | Cycling with a power meter. The gold standard. `TSS = (s × NP × IF) / (FTP × 3600) × 100` |
| **Banister TRIMP** | HR stream + HRrest/HRmax | Anything with a strap. `TRIMP = min × ΔHRr × 0.64·e^(1.92·ΔHRr)` (male) |
| **Edwards TRIMP** | HR stream + zones | Zone-weighted time; simpler, coarser |
| **hrTSS** | HR + threshold HR | TRIMP rescaled so an hour at threshold = 100 |
| **rTSS** | pace + grade + threshold pace | Running, via normalised graded pace |
| **sTSS** | pace + threshold pace (CSS) | Swimming |
| **MET-minutes** | sport + duration only | The floor. Works for everything, including a hike with a dead watch. |

No single one covers this athlete: he rides with power, runs and hikes with HR,
and swims in a pool where the watch may record nothing but laps.

### The decision: a cascade onto one scale

`exertion` is a **TSS-equivalent** — *an hour at functional threshold scores
100* — computed by the best method the activity's data supports, with the method
recorded alongside the number.

```
1. power stream + FTP for that date          → tss        (best)
2. HR stream + HRrest/HRmax/LTHR for date    → hrtss      (Banister TRIMP, rescaled)
3. no streams, but avg HR + duration         → avghr      (flat-HR TRIMP)
4. running/swimming with pace + threshold    → ptss       (rTSS / sTSS)
5. sport + duration (+ distance, elevation)  → met        (floor)
```

Every branch writes `exertion` (a real number, ~0–500) **and**
`exertion_method` (the enum above) **and** `exertion_confidence`
(`'measured' | 'estimated' | 'assumed'`). The UI must never show the number
without a way to see how it was got — a hike scored from a MET table and a ride
scored from a power file are not the same claim, and pretending otherwise is
what makes every other site's "effort score" untrustworthy.

Implementation lives in `src/lib/exertion.ts`, as **pure functions over
streams** — no database access, no I/O — so it can be re-run over the whole
table when a threshold changes.

Key details:

- **Normalised power** is the 30-second rolling average of power, raised to the
  4th power, averaged, 4th-rooted. Needs a 1 Hz stream; fall back to average
  power when the stream is missing, and mark it `estimated`.
- **Thresholds change over time.** FTP in March is not FTP in September. They
  live in `athlete_thresholds` with an `effective_from` date; the calculator is
  handed the row in force on the activity's date.
- **Grade-adjusted pace** for running/hiking: use a polynomial on gradient
  (Minetti's cost-of-running curve is the defensible one) to convert climbing
  into flat-equivalent pace.
- **MET values** come from the Compendium of Physical Activities, per sport, and
  are adjusted by speed/grade where a stream allows.
- **Elapsed vs moving.** Exertion always uses *moving* time. A two-hour café
  stop is not training stress.

---

## 4. Ingestion — import from Strava, sync from the devices

### The honest architecture

Every provider here can emit **FIT**, and Strava's bulk export is FIT/GPX/TCX in
a zip. So the pipeline is one canonical path with thin adapters on the front:

```
Strava archive (.zip)  ─┐
Garmin  (FIT via API)  ─┤
Wahoo   (FIT via API)  ─┼──▶ parse ──▶ canonical Activity + Streams ──▶ dedupe ──▶ exertion ──▶ store
TrainerRoad (FIT)      ─┤
manual file drop       ─┘
```

`src/lib/ingest/` owns this:

- `fit.ts` — FIT decoding (`@garmin/fitsdk`, MIT-licensed, official).
- `gpx.ts`, `tcx.ts` — the XML formats, for older Strava exports.
- `canonical.ts` — the shape everything is converted into before it is stored.
- `dedupe.ts` — see below.
- `providers/strava.ts`, `providers/garmin.ts`, `providers/wahoo.ts`,
  `providers/trainerroad.ts` — one `SyncProvider` interface each.

### Order of work, and why

1. **Strava bulk archive import first.** It needs no OAuth app, no approval, no
   review queue, and it carries the entire history — which is the thing that
   makes every page on this section real instead of a mock. Strava's data export
   ships `activities.csv` plus a per-activity file.
2. **File drop second.** The same parser behind a `POST /api/activities/import`
   that takes a `.fit`/`.gpx`/`.tcx`. This alone already "syncs" Garmin, Wahoo
   and TrainerRoad, because all three can hand you a file today.
3. **OAuth adapters after that**, behind the `SyncProvider` interface, in
   ascending order of friction: Wahoo (straightforward OAuth + webhooks),
   Garmin (Connect Developer Program, requires approval), Strava (OAuth for
   ongoing sync of new rides), TrainerRoad (no public API — it pushes to Strava
   and Garmin, so it is synced *through* them, and this is a documented
   limitation rather than a missing feature).

### Deduplication

Two rows are the same activity when they overlap in time on the same sport.
`dedupe.ts` matches on, in order: `(provider, external_id)` exact; then
`start_time` within ±5 minutes **and** sport equal **and** duration within 5%;
then, if both have GPS, start-point within 200 m. A match keeps the row from the
**higher-fidelity source** (recorded-by-device beats mirrored-from-Strava) and
records the loser in `activity_sources` so the link back to Strava survives.

### A note on Strava's API terms

Strava's API Agreement requires "Powered by Strava" attribution on any view
built from their API, forbids using the data to train models, and forbids
showing Strava data alongside another provider's data in a way that invites
comparison. **The bulk archive is the owner's own data export, not the API**, so
the import path in step 1 is unencumbered. Anything built on the OAuth API in
step 3 must carry the attribution mark. Keep the two paths distinguishable in
`activity_sources.provider` (`strava_archive` vs `strava_api`) so this stays
checkable.

---

## 5. Schema

Migrations start at **0034** — 0033 is taken (see the recovery note at the top
of `0033_place_location_detail.sql`).

### `activities`

The record. One row per activity; a multisport activity is a parent with
children (see `parent_id`).

```
id                  bigint identity pk
sport               text not null          -- canonical slug, see §6
sub_sport           text                   -- 'gravel', 'indoor', 'open_water', 'resort'…
parent_id           bigint references activities(id)  -- triathlon parent; null for standalone
leg                 smallint               -- order within a multisport parent (1 = swim, 2 = T1…)

title               text not null          -- owner's, or the device's default
notes               text                   -- the owner's own writing
private_notes       text                   -- never rendered publicly

started_at          timestamptz not null   -- the instant
local_date          date not null          -- the calendar day WHERE IT HAPPENED. Grid keys off this.
utc_offset_minutes  smallint               -- so a local clock time can be shown
timezone            text

elapsed_seconds     integer not null
moving_seconds      integer
distance_m          double precision
elevation_gain_m    double precision
elevation_loss_m    double precision
elev_high_m         double precision
elev_low_m          double precision

avg_speed_ms        double precision
max_speed_ms        double precision
avg_hr               smallint
max_hr               smallint
avg_cadence          smallint
avg_power_w          smallint
max_power_w          smallint
normalized_power_w   smallint
work_kj              double precision
calories             integer
avg_temp_c           double precision

-- swimming
pool_length_m        double precision
total_strokes        integer
avg_swolf            smallint

exertion             double precision      -- §3. TSS-equivalent.
exertion_method      text                  -- 'tss'|'hrtss'|'avghr'|'ptss'|'met'
exertion_confidence  text                  -- 'measured'|'estimated'|'assumed'
intensity_factor     double precision

-- geometry, for the poster and the map
polyline             text                  -- encoded polyline, full-ish fidelity
route_path           text                  -- normalised SVG path, viewBox 0 0 100 100. See §7.
start_lat/start_lng  double precision
end_lat/end_lng      double precision
bbox_w/s/e/n         double precision
start_place          text                  -- 'Snoqualmie Pass, WA' — reverse geocoded, nullable
gear_id              bigint references activity_gear(id)

favorite_rank        smallint check (between 1 and 4)  -- the landing page's top four
has_streams          boolean not null default false
device_name          text
created_at / updated_at / deleted_at
```

Indexes: `(local_date desc)`, `(sport)`, `(exertion desc)`, `(started_at)`,
partial unique on `favorite_rank where favorite_rank is not null`,
`(parent_id)`.

### `activity_streams`

One row per activity. Streams are big and are only read on the detail page, so
they never join the list queries.

```
activity_id  bigint pk references activities(id) on delete cascade
sample_count integer not null
time_s       jsonb   -- int[] seconds from start
latlng       jsonb   -- [[lat,lng], …]
altitude_m   jsonb
distance_m   jsonb
heartrate    jsonb
cadence      jsonb
power_w      jsonb
speed_ms     jsonb
temp_c       jsonb
grade        jsonb
moving       jsonb   -- bool[]
```

### `activity_laps`

```
id, activity_id, lap_index, name,
start_time, elapsed_seconds, moving_seconds, distance_m,
avg_hr, max_hr, avg_power_w, avg_speed_ms, elevation_gain_m,
lap_type   -- 'lap' | 'interval' | 'rest' | 'transition' | 'length'
```

Transitions in a triathlon are laps of type `transition` on the parent, *and*
child activities with `sport = 'transition'`. Both, because a transition is a
leg you can look at on its own and a marker inside the whole day's effort.

### `activity_gear`

```
id, kind ('bike'|'shoes'|'skis'|'board'|'other'), name, brand, model,
nickname, first_used_on (date), retired_at, distance_m (denormalised),
external_ids jsonb
```

`first_used_on` is when the thing entered service. Null means unknown, and
/activities/gear then falls back to the earliest activity tagged to it — a
floor, not the truth, and the page says so.

### `gear_components`  (0036)

One row per PART INSTANCE on a bike, open or closed. Replacing a chain closes
one row (`removed_on`) and opens another; the service history IS the table.

```
id, gear_id, kind (chain|cassette|chainrings|brake_pads|brake_rotors|wheels|
tires|sealant|valves|bar_tape|cables|bottom_bracket|headset_bearings|
wheel_bearings|cleats|other),
label, installed_on, removed_on, baseline_distance_m, condition, notes,
life_miles int[2], life_months int[2]   -- 0037, per-instance overrides
```

There is deliberately **no mileage column**. A component's miles are
`sum(activities.distance_m) where gear_id = this bike and local_date between
installed_on and coalesce(removed_on, today)` — derived in src/lib/gear.ts, so
re-tagging an old ride can't leave a stale total behind.
`baseline_distance_m` is the one figure that can't be derived: miles the part
carried in from another bike or from before it was tracked.

Labels, wear axes and replacement intervals live in `src/lib/gear-wear.ts`
(`COMPONENT_KINDS`), not in the schema — the check constraint only owns "is it
one of these". Intervals are **windows** (`[due, overdue]`), never single
thresholds, because a chain is not dead at exactly 3,000 miles. Parts with no
mileage or calendar interval at all (bearings, valves) get no wear bar rather
than a fabricated one.

Those intervals are **defaults about a category, and a category is not a
part** — a 28mm race tire and a 45mm gravel tire are both `tires` and are not
the same question. `life_miles` / `life_months` (0037) let any instance carry
its own window; `effectiveMeta()` lays them over the default, so an override
*replaces* an axis rather than adding to it, and clearing it falls back. An
override on an axis the kind doesn't otherwise have is honoured too — that is
how a bottom bracket gets a wear bar at all. Overridden rows are marked `*` on
the detail page, because a reader comparing two chains has to know one is being
judged against a different ruler.

The windows are a **rough heuristic for when to go and look**, not a
measurement: wear is read by hand off the part and never recorded digitally, so
the bar's job is to schedule the inspection, not to replace it.

**Not every part wears indoors.** A trainer turns the cranks but the bike
doesn't move, so the drivetrain wears normally while the tires aren't on the
road, the brakes are never touched and the wheels carry no load over anything.
`brake_pads`, `brake_rotors`, `wheels` and `tires` are marked `outdoorOnly` in
`COMPONENT_KINDS` and see the window's outdoor rides only; everything else sees
all of them. "Indoor" is `sportMeta(sport).indoor || sub_sport === 'indoor'` —
`isIndoorRide()`, the same heuristic the route reader and the `indoor` filter
already use, not a second one. When the exclusion actually discarded something
the part says so, since otherwise a tire's odometer and the chain's disagree on
the same bike with no account of why.

`wheels` and `wheel_bearings` are deliberately separate kinds (0040). A
wheelset outlives several sets of the bearings inside it, so folding them
together would either erase the wheel's history on a bearing service or leave
the wheel's mileage counting from one.

**Component mileage will not match Strava's.** Strava's per-component figure is
a counter accrued at upload time; this site's is a live sum over the activities
in the window the part was fitted. Loading the Cervélo's history (0041) showed
them agreeing to a tenth of a mile on every component closed before Nov 2024
and diverging by 2–10% on everything still accruing since. The derived figure
is the one to trust — that is the whole reason nothing here is denormalised —
and Strava's numbers are deliberately **not** written into
`baseline_distance_m`, which would only reinstate the disagreement as data.

### `activity_sources`

Provenance, and the dedupe survivors.

```
id, activity_id, provider ('strava_archive'|'strava_api'|'garmin'|'wahoo'|
'trainerroad'|'file'|'manual'), external_id, external_url,
file_name, file_checksum (sha256, for idempotent re-imports),
fidelity smallint,  -- higher wins a dedupe
raw jsonb,          -- what the provider said, verbatim
imported_at
```

Unique on `(provider, external_id)` where `external_id` is not null; unique on
`file_checksum` where not null.

### `athlete_thresholds`

```
id, effective_from date not null,
ftp_w smallint, lthr_bpm smallint, max_hr smallint, rest_hr smallint,
threshold_pace_s_per_km double precision,      -- running
css_pace_s_per_100m double precision,          -- swimming
weight_kg double precision
```

Exactly one row is "in force" on a given date: the latest `effective_from <=`
that date.

### Views

- `activity_list` — everything the list/landing pages need and nothing they
  don't (no streams, no raw). Joins gear name and source provider.
- `activity_days` — one row per `local_date` with counts, total distance, total
  exertion, total moving time. What the week grid reads.
- `activity_months` — per-month rollups for the month-in-review header.

RLS on, `select` granted to `anon, authenticated` on the views; writes go
through `supabaseAdmin` behind `requireOwner`.

---

## 6. Sports

Canonical slugs, ordered by how much of this athlete's life they are:

```
ride            gravel_ride   mountain_bike   virtual_ride
run             treadmill_run   trail_run
swim            open_water_swim
transition
hike            walk   snowshoe
alpine_ski      backcountry_ski   nordic_ski   snowboard
strength        yoga   rowing   other
```

`src/lib/sports.ts` owns the slug → `{ label, icon, family, metersPreferred,
primaryStats }` table. **`primaryStats` is what makes the detail page
sport-aware** — the ordered list of stat keys that sport leads with:

- ride: distance, elevation gain, moving time, avg power, NP, avg speed, exertion
- virtual_ride: moving time, avg power, NP, avg HR, work (kJ), exertion
- run: distance, moving time, avg pace, avg HR, elevation gain, exertion
- treadmill_run: distance, moving time, avg pace, avg HR, exertion
- swim: distance, moving time, avg pace /100m, SWOLF, pool length, exertion
- open_water_swim: distance, moving time, avg pace /100m, water temp, exertion
- transition: elapsed time. That is the whole story of a transition.
- hike: distance, elevation gain, moving time, elev high, exertion
- alpine_ski: vertical descent, runs, max speed, moving time
- default: distance, moving time, elevation gain, avg HR, exertion

---

## 7. The route "poster"

The film log's tile is a poster. Here it is **the shape of where you went**, and
it has to survive forty-to-a-page with no map tiles and no JavaScript.

So at ingest time, `src/lib/route-shape.ts` turns the GPS track into a
**normalised SVG path string**, stored on the row as `route_path`:

1. Decode the polyline to `[lat, lng][]`.
2. Project web-mercator (so the shape isn't squashed at latitude).
3. Simplify (Ramer–Douglas–Peucker) to ≤ 200 points — a 60px thumbnail cannot
   show more, and the string has to stay small enough to sit in a list query.
4. Fit to a `0 0 100 100` viewBox preserving aspect, centred, with 6 units of
   padding.
5. Emit `M x y L x y …`, coordinates to 1 decimal place.

The card then draws `<svg viewBox="0 0 100 100"><path d={route_path}/></svg>` in
`lake` on `snow`, plus two or three stats. **A card with no GPS** — trainer,
treadmill, pool — draws no route and gives its whole face to the stats, set
large. It must read as a deliberate second design, not as a broken first one.

Component: `src/components/ActivityCard.astro`. Props: one `ActivityListRow`
plus a `size` (`'tile' | 'row' | 'cell'`).

---

## 8. Filters and sorts on `/activities/all`

Filters: sport (multi), date range, distance range, duration range, elevation
range, **exertion range**, has-GPS, gear, indoor/outdoor, has-power, has-HR,
place (start_place), favourites only, personal-best only.

Sorts: date (default, desc), **exertion**, distance, duration, elevation gain,
avg speed / pace, avg power, avg HR, calories.

Same split as the film log: `src/lib/activity-params.ts` parses the query string
for both the page and the list API so the server-rendered first page and the
batches paged in afterwards cannot drift.

---

## 9. Who builds what

Files are assigned so two agents never write the same file.

| Track | Owns |
| --- | --- |
| **Schema** | `supabase/migrations/0034…`, `src/lib/activities.ts`, `scripts/seed-activities.mjs` |
| **Effort** | `src/lib/exertion.ts`, `src/lib/route-shape.ts`, `src/lib/sports.ts` |
| **Shell** | `src/layouts/ActivityLayout.astro`, `src/lib/activity-tokens.ts`, `src/components/ActivityCard.astro`, `src/lib/nav.ts` (one line) |
| **Landing** | `src/pages/activities/index.astro`, `src/lib/activity-week.ts` |
| **List** | `src/pages/activities/all.astro`, `src/lib/activity-params.ts`, `src/pages/api/activities/list.ts`, `.../facets.ts` |
| **Detail** | `src/pages/activities/[id].astro`, `src/components/ActivityMap.astro`, `src/lib/activity-map.ts` |
| **Month** | `src/pages/activities/month/*.astro`, `src/lib/activity-month.ts` |
| **Ingest** | `src/lib/ingest/**`, `src/pages/api/activities/import.ts`, `src/pages/activities/import.astro`, `scripts/import-strava-archive.mjs` |
