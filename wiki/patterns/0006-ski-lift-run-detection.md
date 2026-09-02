# 0005 — Segment a ski day's altitude sawtooth into runs and lifts

**Type:** strategy
**Applies when:** doing anything with lift-served ski/snowboard activities —
exertion, run counts, a Slopes-style breakdown — or facing any GPS track that
alternates a slow climb with a fast descent (also true of some via-ferrata /
shuttle-lap MTB days).

## The problem

A resort day arrives as one continuous track. The file does not label its runs
or lifts, and two obvious duration fields both lie:

- `elapsed_seconds` is the whole day, most of it chairlift and lodge.
- `moving_seconds` on this archive's **Slopes GPX exports is broken** — 465s for
  a full day with 10,000m of vertical. Do not trust it for ski sports.

The `activity_laps` rows are no help either: on these days they're Strava's
arbitrary auto-laps, each spanning part of a lift AND part of a run.

## What works

Segment the **altitude** stream, not speed. The per-sample speed channel on
these exports spikes to 55 m/s (200 km/h) on GPS glitches; altitude drifts a few
metres but its *trend* is clean. `src/lib/ski.ts`:

1. Smooth altitude over a ~15s centered window (kills baro/GPS noise).
2. Walk it with a hysteresis band (`NOISE_M = 8`): a segment closes at a running
   extreme only once altitude pulls 8m back off it, so wiggles inside a long
   lift or run don't shatter it.
3. Label each segment by net vertical: ≤ −25m = run, ≥ +25m = lift, else idle.

Validated against 54 real days: summed run drop matches stored `elevation_loss_m`
within ~1–2%, run counts land at a believable 14–25/day.

Gotchas that cost time:
- **Per-run MAX speed is unrecoverable** from these streams — even distance-
  derived speed over a 4s window pins at any cap you set, because the distance
  stream itself jitters. Use the activity's stored `max_speed_ms` (de-noised) for
  the day max, and per-run **average** speed (distance ÷ time), which washes the
  noise out over minutes.
- For exertion, sum active time **sample-by-sample over moving run samples**, not
  per-segment — a lunch stop mid-run sits inside a run's altitude envelope but
  isn't skiing.

## Exertion hookup

`exertion.ts` gets a rung 4.5 (`method: 'ski'`, `estimated`) between the pace
rung and the MET floor: MET-minutes on the active-descent time at an active ski
MET (alpine 7, board 6), not sports.ts's deliberately-low whole-day MET. Only
`alpine_ski`/`snowboard` — backcountry/nordic are self-powered. Adding a method
value needed widening the `activities_exertion_method_check` constraint (0050).

## Editing the partition, and showing it

Detection is right almost always; the "almost" (a lift you hiked, a cat-track
called a run) is why `activities.ski_segments` exists (migration 0051): a stored
`[{t0,t1,type}]` partition in seconds-from-start that, when present, REPLACES
detection everywhere via `resolveSkiSegments(streams, override)` — display,
profile, and the exertion score. Key moves:

- **Reclassify is the whole editor** — no split/merge/drag. Merge falls out for
  free: `coalesce()` joins adjacent same-type segments, so relabelling the idle
  between two runs collapses the three. Split (rare) is deferred.
- **Exertion must honour the override**, so `computeExertion` takes an optional
  `ski_segments`, and BOTH `saveSkiSegments` (the editor) and
  `recompute-exertion.mjs` pass it — otherwise a bulk re-score silently reverts
  every edit to auto-detection.
- **Profile bands**: `buildGraphData` takes the resolved segments and emits
  axis-offset bands (`skiSegments`), drawn as coloured `<rect>`s behind the
  elevation trace in ActivityGraph, toggled by a chip, ON by default for ski.
  Read the bands off the RAW stream indices, not the downsampled graph indices,
  or they drift from the turn that defined them.
- **Testing the save path**: `saveSkiSegments` pulls in `supabase.ts`, which
  reads `import.meta.env` — so it only runs inside Astro (dev server), NOT bare
  node. Verify by `curl -X POST` to a running `astro dev`, and you MUST send an
  `Origin:` header matching the host or Astro's origin check 403s the form post.

## Cheapest check

`npm run ski:test` (synthetic sawtooth + the override/coalesce/exertion path).
For real data, the run-drop sum should track `elevation_loss_m`. See
[[0002-screenshot-the-page-yourself]] for the detail-page render.
