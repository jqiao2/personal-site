# 0007 — Placing SiteHeader on a page that centres its own column

**Type:** strategy
**Applies when:** adding `<SiteHeader>` to a page, or auditing which pages have one.

## Audit it through the layouts, not just the pages

`grep -rl SiteHeader src/pages` under-reports. The restaurant and activity
sections get their header from `RestaurantLayout` / `Layout`, so their pages
never name it. Grep `src/layouts` too, and remember that redirect-only routes
(`films/[id]`, `films/month/index`, `books/month/index`) render no markup and
need nothing.

## The strip bleeds; it does not need to be a top-level child

`.sh` is `width: 100vw; margin-left: calc(50% - 50vw)`, so it escapes whatever
box it sits in. That means on a page whose `.page` is
`display: flex; justify-content: center`, you do **not** have to restructure
the CSS — put the header inside `.wrap` as its first child and the bleed
cancels the centring and the page's side padding exactly. Add
`overflow-x: hidden` to `.page`: `100vw` counts the scrollbar.

## Aligning the nav with the content under it

The header's inner column is `--sh-max` wide with `--sh-pad` of gutter; the
page's column is `max-width` wide with the gutter on `.page` instead. They line
up only when

    --sh-max = column width + 2 × --sh-pad

(film theme's pad caps at 32px, the default at 28px). `SiteHeader` takes an
optional `max` prop for this — the film subpages run 760–1000px against the
film log's 1120px card, and skipping it left the nav ~90px off. The nav text
still sits 15px inside that, which is the link's own padding and is correct;
compare against `films/index`, where card and header share 1120px.
