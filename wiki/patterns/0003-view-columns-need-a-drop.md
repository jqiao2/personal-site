# 0003 — `create or replace view` cannot change a column list

**Type:** failure-mode
**Applies when:** a migration adds a column to `restaurants` / `restaurant_visits`,
or removes one from `restaurant_places` / `restaurant_diary`.

## What goes wrong

`create or replace view` may only APPEND columns to the end of an existing
view. It cannot remove one, reorder them, or change a type. Both restaurant
views are affected in the two directions:

- **Adding a table column** does not reach a view that selects `r.*`. Postgres
  expands the star ONCE, at creation, into the column list as it stood. The new
  column is invisible until the view is rebuilt — and `replace` cannot do the
  rebuild, because a column arriving in the middle of `r.*` lands ahead of
  everything the view computes. Bitten by 0031 (`trip`, `to_try_tags`).
- **Removing a column** the view lists explicitly is a drop for the same
  reason. Bitten by 0049 (`restaurant_diary.price_band`).

Either way the migration runs clean and the app reads stale columns.

## The fix

`drop view if exists …; create view … with (security_invoker = true) as …;`
then **reissue the grant** — dropping takes `grant select … to anon,
authenticated` with it, and a missing grant is a 401 from PostgREST on a page
that used to work, not an error at migration time.

Copy the whole view body forward into the new migration rather than editing an
old file: an applied version is never read again (see CLAUDE.md).

## Cheapest check

After `db push`, one REST call for the column that moved:
`curl "$SUPABASE_URL/rest/v1/restaurant_diary?select=id,<column>&limit=1" -H "apikey: $SUPABASE_ANON_KEY"`
— a present-but-stale view answers 200 with the old shape, and a lost grant
answers 401.
