# 0042 — Reading a Letterboxd watchlist

**Type:** strategy · **Applies when:** syncing or importing a Letterboxd watchlist, or turning a Letterboxd film into a TMDB id

- There is no watchlist RSS and no public API. `letterboxd.com/<user>/watchlist/page/N/`
  is plain HTML, 28 films a page, newest added first. Each poster is a `LazyPoster`
  div with `data-item-slug` (older markup: `data-film-slug`). A page past the end
  answers 200 with an empty grid, so stop on the first empty page.
- The list page has no TMDB id. The film page does: `<body data-tmdb-type="movie"
  data-tmdb-id="238">`. Miniseries listed as films (Twin Peaks: The Return, Sharp
  Objects) carry `data-tmdb-id=""`. Cache slug → id (`letterboxd_films`) so a daily
  run only reads the pages of new films.
- The header count ("wants to see 518 films") ran two above the films the grid
  listed (516). Don't use it as a completeness check.
- Resolving by TMDB id beats the title/year search in `backfill-watchlist.mjs`: that
  import put the wrong *Under the Skin* (698232) and *The Witch* (526667) on the list.
- Never let a failed or empty read turn into removals: the sync throws on a failed
  page, refuses an empty list, and holds removals while any slug is unresolved or
  when more than 25 would go.
