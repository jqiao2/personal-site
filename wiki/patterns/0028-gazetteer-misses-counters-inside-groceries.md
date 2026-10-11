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

## Fix directions

- Overture: select `taxonomy.primary`, and filter on the food categories above
  (or on `taxonomy.hierarchy`) instead of a substring list. Grocery and
  convenience stores are a judgement call: they help address search find a
  counter like this one, but they are noisy.
- Import NYS Ag & Markets Retail Food Stores (`data.ny.gov` `9a8c-vfzj`, Socrata,
  no key needed, about 11.5k NYC rows) as a fifth `place_sources` source. Rows
  carry `dba_name`, `entity_name`, the address and a point.
- For names that only Google knows, use a live Google Places lookup or parse a pasted
  Google Maps share link.

## How it was checked

DuckDB over the public Overture HTTPS bucket, with a tiny bbox around the address
and a category histogram for the NYC box. Socrata `$where` on both open-data
APIs. Overpass `around:150`, which needs a `User-Agent` header or it answers 406.
