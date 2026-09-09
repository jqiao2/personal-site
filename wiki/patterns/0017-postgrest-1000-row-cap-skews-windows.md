# PostgREST's 1000-row cap silently skews a percentile window

**Type:** failure-mode
**Applies when:** a Supabase/PostgREST `select().gte().lte()` (or any filter) is
used to gather a *population* to compute a statistic over — a percentile, a
median, a mean — rather than to fetch a bounded list.

## Symptom
The statistic is close but consistently wrong. Here: the live credit-sync path
scored a new film's era-adjusted percentile against a ±2-year window of
contemporaries, and got 0.595 where the offline batch got 0.622 — every film a
little off, none exactly right. The math was identical; the *input set* wasn't.

## Root cause
PostgREST caps a response at 1000 rows unless you page. A ±2-year window in a
busy decade holds several thousand corpus films, so `select().gte().lte()`
returned only the first 1000 (here ordered by whatever default), and the
percentile was computed over a truncated, biased sample. Nothing errors — you
just get a plausible wrong number.

## Fix
Page the whole window before computing, with an explicit stable order so
`.range()` is deterministic:

```ts
const rows = [];
for (let offset = 0; ; offset += 1000) {
  const { data } = await sb.from('credit_films').select('vote_count, revenue')
    .gte('release_year', y - span).lte('release_year', y + span)
    .order('tmdb_id', { ascending: true }).range(offset, offset + 999);
  rows.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}
```

Verify a live/incremental statistic against the offline batch that populated the
same column: recompute a handful of rows and assert equality. That check — 0/6
films matching, while 8/8 people (which aggregated *stored* per-film values,
never re-querying a window) matched perfectly — pinpointed the window read as the
culprit, not the arithmetic.

See the `readAllPages` helper in `src/lib/films.ts` for the same paging over the
watch log; the credit-graph scripts carry their own `readAll`.
