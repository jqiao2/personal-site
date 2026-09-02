# The place gazetteer only ever had one of its four sources

**Type:** failure-mode · **Applies when:** a restaurant the composer should know
is missing, a suggestion is ALL CAPS, or co-located venues collapse into one row

## Symptom

- A well-known place ("Don Poke") is not offered while typing, so it gets added
  by hand.
- Suggestions come in block capitals ("SABOR LATINO SPANISH AMERICAN").
- Two businesses at one address (a restaurant and its bar, "Gulp / 929") appear
  as a single suggestion, or the place lives buried inside a ghost-kitchen
  cluster name (`"…/ DUM POKE /…"`).

## Root cause

`place_sources` (see migration 0032) was designed for four datasets — `dohmh`,
`overture`, `foursquare`, `osm` — but only **`dohmh` was ever imported**.
`@duckdb/node-api`, which the Overture/Foursquare importers need, was not even a
dependency. So the whole gazetteer was the NYC health department's permit list,
and that list has two structural limits nothing in the code could fix:

- **It shouts.** Every DBA is stored upper-case; the awning case is unrecoverable.
- **One row per permit.** Co-located venues and virtual brands collapse, because
  the city issues one CAMIS per kitchen, not per name on the door.

## Fix

1. **Title-case dohmh on read**, at the one choke point (`searchGazetteer` in
   `src/lib/gazetteer.ts`), gated to `source === 'dohmh'` and to names that are
   actually all caps, with a small `KEEP` acronym set (BBQ, ABC, NYC). The stored
   candidate stays raw; the copy into `restaurants` gets the cased name.
   Already-visited `restaurants` rows were a one-off data backfill with the same
   function. Test: `npm run gazetteer:test`.
2. **Run the other importers.** `npm i -D @duckdb/node-api`, then
   `node --env-file=.env scripts/import-place-source.mjs overture --bbox nyc --commit`.
   Overture (60k+ NYC POIs, CDLA-permissive, anonymous) lists each brand as its
   own point — Don Poke, both Gulps, etc. It is the storable global source that
   works without credentials.

## Gotchas

- **Overture reads are flaky.** The S3 listing and the Supabase writes each drop
  a connection now and then; a single throw used to lose the whole run or a silent
  500-row chunk. The importer now retries both (`fetchRetry`, and a retry loop on
  the upsert). Re-running is idempotent (upsert on `source,source_id`).
- **Foursquare is gated now (2026-09).** `resolve/main/…parquet` on HuggingFace
  answers 401 anonymously, which DuckDB surfaces as "HTTP 0". It needs a HF token.
  Overture already covers the NYC gap, so this was left documented, not solved.
- **Importing any `src/lib` module under plain node** used to crash in
  `supabase.ts` on `import.meta.env` (undefined off Vite). It now falls back to
  `process.env`.
