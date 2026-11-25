# 0041: The previous page comes from the Navigation API, not the referrer

- **Type:** strategy
- **Applies when:** adding a back link, or needing to know which page of ours came before this one

Use `src/components/BackLink.astro`. Don't hand-roll a `history.back()` handler.

`document.referrer` can't answer "what was the previous page": after a filter link
or a form post it is the same page, and after a replaced history entry it can be
wrong. `navigation.entries()` is the tab's real same-origin history, already right
across reload, back/forward and `location.replace`. Skip entries with the current
pathname and use `traverseTo(key)`, which restores scroll.

Entries carry no titles, so SiteHeader saves each page's under `title:<path>` in
localStorage. A page's `<title>` must therefore lead with its own name
("Settings · Flight Poster", not the reverse). A redirect after deleting a page
should be `location.replace`, or the next back link points at a 404.
