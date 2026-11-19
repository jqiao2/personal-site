# MTA per-line metrics from data.ny.gov: aggregate server-side, fold renamed lines

**Type:** strategy · **Applies when:** pulling MTA subway/bus performance by line or route (anything like /projects/mta-savant)

## What works

- The MTA publishes monthly per-line datasets on data.ny.gov (Socrata, no key):
  subway wait assessment `s666-h6b7`, terminal OTP `f6rf-2a3t`, service delivered
  `32ch-sei3`, customer journey `r7qk-6tcy`, trains delayed `9zbp-wz3y`, major
  incidents `ereg-mcvp`; bus speeds `cudb-vcni`, wait `v4z4-2h6n`, service delivered
  `6qwi-vjde`, customer journey `8mkn-d32t`, routes `bzwk-3hb4`. Find more with
  `https://data.ny.gov/api/catalog/v1?q=MTA%20subway&only=dataset`.
- Let SoQL do the summing: `$select=line, month, sum(a*b) as v&$group=line, month`.
  Arithmetic inside and between aggregates works (`sum(x)-sum(y)`). Pull the
  numerator and denominator *sums*, not the published ratio, so years and trailing
  windows aggregate correctly. Bus at route×month since 2019 is ~35k rows per query.
- A cross-dataset ratio (delays ÷ scheduled trips) needs the denominator restricted
  to months the numerator reports, or years before the numerator's dataset begins
  come out as 0.

## Gotchas

- Line codes changed in Sep 2024 in some datasets only: `FS`/`GS`/`H` are the
  Franklin/42 St/Rockaway shuttles (`S Fkln`/`S 42nd`/`S Rock` before), and `J`
  replaced `JZ`. Fold them or a line's history splits in two.
- `32ch-sei3.service_delivered` holds nonsense values (~0.0097); compute
  `num_actual_trains / num_sched_trains` instead.
- `sp9g-mzjh` (end-to-end running times) only returned GS rows when grouped by line.
- A bus route has several `route_type` rows in `bzwk-3hb4` (B44+ is SBS *and*
  School Limited); prefer the non-school one.
- The W has no OTP, trains-delayed or major-incident rows after spring 2018 (and
  the delays dataset's column docs leave it out): it is probably reported under the
  N. For a stat every line has, service alerts `7kct-peq7` tag lines in
  `affected` as `"A | H"`; group by that string server-side and split in JS. Filter
  `agency = 'NYCT Subway' and update_number = 0` to count each incident once.
  Alerts use GTFS ids (H = Rockaway shuttle, 6X/7X/FX = express variants) and lag
  the other datasets by a couple of months.
- Wait/Ride/Net Value (`src/lib/mta-savant-value.ts`) are run-value analogues:
  (rider-weighted mode average − line's per-rider extra minutes) × riders ÷ 60 =
  rider-hours/month above average. Each mode sums to zero; check that after any
  change to the rates or the riders series.
