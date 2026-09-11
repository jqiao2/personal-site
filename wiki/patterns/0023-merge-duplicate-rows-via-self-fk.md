# Merge duplicate rows non-destructively via a self-FK

**Type:** strategy
**Applies when:** the same real thing exists as several rows in one table and a
computed flag (e.g. `on_to_try`) desyncs across them, or you need to dedupe rows
that other rows point at (visits, photos).

## Why not delete

`restaurants` is one table for two states — visited, and to-try — and a place
can arrive twice (added to-try from one gazetteer source, logged as a visit from
another; picking a suggestion COPIES fields in, never joins). The visit lands on
one row, the to-try flag on the other, and `restaurant_places.on_to_try`
(`to_try_added_at is not null AND visit_count = 0`) never goes false because the
two facts live on different rows. Deleting a duplicate risks erasing a real
place that other tables reference; a wrong dedupe is unrecoverable.

## The shape

- `alter table … add column merged_into bigint references <self>(id)`. Non-null =
  "this row is folded into `merged_into`". Index `where merged_into is not null`.
- Both `security_invoker` views get `where <base>.merged_into is null`. You must
  `drop view` + recreate to add the predicate — `create or replace` only appends
  columns (wiki 0003). Copy the LATEST body of each view (grep migrations for the
  most recent redefinition — `restaurant_places` was last defined in 0048, not
  0033; `restaurant_diary` in 0049) so you don't regress columns.
- Merge order (supabase-js has no transaction, so partial failure must stay
  coherent): (1) repoint child rows (`restaurant_visits.restaurant_id`) to keep,
  (2) fill onto keep only what it's MISSING + union arrays, (3) set `merged_into`
  on the drops LAST. Nothing vanishes from a view before its visits move.
- Un-merge = `update … set merged_into = null`.

## Gotchas hit

- `restaurants.favorite_rank` was DROPPED in 0048 — the task's spec still listed
  it. Check the CURRENT schema (grep `add/drop column` across migrations), not a
  design doc, before writing merge/union field lists.
- `normalise()` (gazetteer) splits on every non-alphanumeric, so `Wu's` →
  `WU S`. Two apostrophe spellings do NOT normalise equal; don't assume they do
  in test fixtures. Real duplicates match because a source repeats the exact name
  or one name contains the other.
- Dedupe detector must be conservative: name match AND haversine < ~150m, so a
  chain's branches (same name, far apart) never merge. Only fall back to
  name+city when a row has no coordinates — that's the unplaced-to-try row that
  actually needs merging. `scripts/merge-duplicate-restaurants.mjs` (dry-run
  default, `--commit`, `--self-check`).
