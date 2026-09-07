# 0014 — Infinite scroll without a second renderer: an Astro partial

**Type:** strategy
**Applies when:** a page has to append more of itself as you scroll — a calendar
run, a feed, a long list — and the rows are already rendered server-side.

## The trap
The obvious move is to ship the rows as JSON and rebuild them with
`createElement` in a `<script>`. That gives you two renderers for one thing, and
in Astro it also gives you unstyled output: scoped CSS keys off a
`data-astro-cid-*` attribute the server adds, and hand-built nodes never carry it
(see the "Astro scoped styles vs JS-built nodes" note — `:global()` is the escape
hatch, and it's a bad one at this size).

## What works
Put the rows in a component, then render that component from **two** places:

1. the page, for the first block;
2. a sibling route with `export const partial = true`, for every block after.

```
src/components/ScreeningCalendar.astro       # rows + their <style>
src/pages/films/screening-room.astro         # <ScreeningCalendar rows={first} />
src/pages/films/screening-room/months.astro  # partial: same component, ?from=…
```

The client is then four lines: `fetch` the partial, `insertAdjacentHTML` the text
onto the container, advance the cursor.

Two things make this work:

- **A partial returns bare markup** — no doctype, no `<head>`, so no duplicated
  styles or scripts come with it.
- **The scope hash is per component file, not per page.** Both renders emit the
  same `data-astro-cid-…`, and the styles the page already carries apply to the
  appended rows. Verified: appended cells come back with the page's hash and a
  computed `min-height` of 118px, the value from the component's `<style>`.

Corollary: the component holds the CSS for the rows; the page holds the CSS for
the container around them. Nothing about the appended block is a special case.

## Two things it breaks
- **Handlers bound at load miss appended nodes.** Delegate from the container —
  and fix it at the source: `ScreeningComposer` used to snapshot
  `[data-open-screening]` on load, so it now matches at click time instead, which
  fixes every future caller too.
- **Paginate by the unit that can't be split.** A calendar paginated by month
  duplicates the week that straddles a seam. Pages of *weeks* tile exactly, and
  the month label becomes a row emitted in front of the week carrying a 1st.
  `scripts/screening-calendar.test.mjs` asserts consecutive pages share no week
  key and no month gets two barriers.
