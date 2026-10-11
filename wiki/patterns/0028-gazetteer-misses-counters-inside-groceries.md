# The gazetteer misses food counters that live inside a grocery licence

**Type:** failure-mode · **Applies when:** a real, open food place is missing from
the composer's suggestions even though DOHMH and Overture are both imported

## Symptom

"Bagels & Grill", 9 Bay 50th St, Brooklyn (open 24 h, on Google Maps) is offered
by no suggestion source, so it can only be added by hand.

## Root cause (three layers, checked 2026-10-11)

1. **DOHMH never had it.** The health-department inspection set (`43nn-pn8j`)
   has nothing at that address or phone. Many bagel/deli counters operate under a
   **NY State Ag & Markets retail-food-store licence**, not a DOHMH restaurant
   permit. The state lists this address as `BARRON GROCERY STORE`
   (Unlimited Opportunity Inc). It also lists `BEST BUY 24HR BAGELS` and `2819
   CROPSEY BAGELS & DELI` nearby, and neither of those is in `place_sources`.
2. **Overture had it and the importer dropped it.** Overture lists the address as
   `Barrons Groceries`, `grocery_store`. `fromOverture` keeps only categories that
   contain `restaurant`/`food` or appear in an 11-item list, so it drops
   `delicatessen` (3.2k NYC rows), `sandwich_shop` (1.4k), `bagel_shop` (780),
   `donut_shop`, `smoothie_juice_bar`, `cocktail_bar`, `dessert_shop`,
   `bubble_tea_shop`, `steakhouse` (413, which has no "restaurant" in its slug), `wine_bar`, and so on.
   Grocery and convenience stores (9.4k) also go.
3. **The name exists only on Google.** No open source carries the trade name
   "Bagels & Grill". Every licence and POI dataset names the grocery that holds it.

## Also broken: the Overture schema moved

Release `2026-09-23.1` has **no `categories` column**. It now has `taxonomy`
(`primary`, `hierarchy[]`, `alternates[]`) and `basic_category`. The importer's
`categories.primary` throws a Binder Error on every file, so **a re-import fails
today** until the query moves to `taxonomy.primary`.

## Fix (2026-10-11)

- **Overture** now filters on `taxonomy.hierarchy[1] = 'food_and_drink'` and
  reads `taxonomy.primary` as the cuisine. That root covers restaurants, casual
  eateries (bakeries, delis, bagel and sandwich shops), bars, cafes, juice and
  bubble-tea shops, about 72k open NYC places. Groceries and liquor stores are under
  `shopping` and stay out, because the state list covers the counters inside them.
- **New source `nys`** (migration 0067): NYS Ag & Markets Retail Food Stores,
  `data.ny.gov` `9a8c-vfzj`, NYC counties only. It keeps licences whose
  `estab_type` contains C (food prep) or B (bakery), about 9.5k rows. A bare `A` is
  a shop with no food made on the spot. Names are all caps, so `gazetteer.ts`
  title-cases `nys` as it does `dohmh`.
  `node --env-file=.env scripts/import-place-source.mjs nys --commit`
- This place now comes up when you type its address ("9 bay 50" →
  Barron Grocery Store). Its trade name still exists only on Google.

## Gotchas

- Re-imports upsert and never delete. Overture rows that the old filter let in
  (food banks, delivery services) or that have since closed stay in the table.
  Remove them by `imported_at` older than the latest run if they get in the way.
- `@duckdb/node-api` is still not in `package.json`, because it is a large native
  module and a Vercel build doesn't need it. Install it ad hoc
  (`npm i --no-save @duckdb/node-api`) before an Overture run.

## How it was checked

DuckDB over the public Overture HTTPS bucket, with a tiny bbox around the address
and a category histogram for the NYC box. Socrata `$where` on both open-data
APIs. Overpass `around:150`, which needs a `User-Agent` header or it answers 406.
