# A search box on a "filters are links" page is a plain GET form

**Type:** strategy
**Applies when:** adding a free-text search to a server-rendered page whose
filters are query-string links, and the search must survive a reload/share and
keep the other active filters.

## The bargain

The restaurant list pages are JS-free on purpose: every filter is an `<a>` that
re-states the URL, so the state lives in the query string and a share carries it
(see the header comment in `places.astro`). A text search can't be a link — you
don't know the value ahead of time — but it does NOT need a script either.

A native `<form method="get">` submits its fields as the query string. Make the
search input `name="q"`, and re-emit every OTHER current param as a hidden input
so submitting a query preserves the active filters:

```astro
<form class="rl-search" method="get" action="/restaurants/places" role="search">
  {[...params.entries()].filter(([k]) => k !== 'q' && k !== 'page')
    .map(([k, v]) => <input type="hidden" name={k} value={v} />)}
  <input type="search" name="q" value={q} />
</form>
```

Drop `page` from the carried params (a new search starts on page 1), exactly as
the `href()` helper already deletes `page` on any non-pager change. `type="search"`
submits on Enter — no keydown handler, no debounce, no client JS at all. This is
rung 4 of the ladder (native platform feature) beating the "smallest inline
script" the brief allowed for.

## The matching logic belongs in the data layer, shared

Mirror `searchPlaces`'s term-splitting (it already word-matches name + location
for the composer): split on whitespace, strip the same `,%*()"` chars, lowercase,
and require EVERY term to appear across name + neighborhood + city + state_region
+ country. Two tiny exported helpers in `restaurants.ts` — `searchTerms(q)` and
`matchesSearch(fields, terms)` — serve both `listPlaces` (via a new `search?` on
`PlaceQuery`) and `diary.astro` (which matches `DiaryVisit` fields directly).
`restaurants` rows have no street column, so "address" = the location fields.

## Collapsing the chip bar

The chip rows collapse behind a native `<details class="rl-filterbox">` — same
idiom as the existing `.rl-more` disclosures, no JS, and instant (the site does
not move, so no transition). Keep the search box OUTSIDE the details (primary
action, always visible) and the Active-filters row outside too (so clearing is
always reachable). Server-render `open={anyChipFilterActive}` so a filtered view
never hides why it's filtered — search itself doesn't force it open, since the
box shows the query anyway.
