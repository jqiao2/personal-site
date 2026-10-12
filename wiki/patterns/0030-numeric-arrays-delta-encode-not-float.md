# 0030 — Shrinking numeric arrays in Postgres: delta-encode, don't switch to floats

**Type:** strategy
**Applies when:** a table of long numeric series (GPS tracks, sensor streams,
time series) stored as JSONB is eating the database size cap.

## Symptom
`activity_streams` was 144 MB of a 500 MB free tier, almost all TOAST. The
obvious fix, JSONB → `real[]`/`float8[]`, made it **bigger**: 170 MB.

## Root cause
TOAST compresses each value with pglz. JSONB stores short decimals like `24` or
`3.09` as text, which compresses fine. Binary floats are 4–8 bytes of
near-random mantissa per sample and barely compress at all. Fixed-point ints
alone only saved 10%.

## What works
Store `round(v × scale)` as the change from the previous sample. Consecutive
samples differ by small, repeating amounts (`time_s` is almost all `1`), which
pglz squeezes hard: −66% on a measured sample, no loss. Pick each scale from
the precision the data actually has, and check it with
`count(*) where v*scale <> round(v*scale)` before choosing it.

Measure on a temp-table sample first: a full-table conversion via the MCP
`execute_sql` times out.

Rebuild into a new table and swap it in, rather than `UPDATE` in place. An
update leaves the old TOAST as dead tuples that only `VACUUM FULL` returns.

## Seen
- 2026-10-12 — migration 0070 + `src/lib/stream-codec.ts`.
