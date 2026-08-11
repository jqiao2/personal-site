# Design prompt — the restaurant log

Paste everything below the rule into Claude. It asks for a design, not an
implementation: the output is HTML/CSS mockups to react to, which then get
rebuilt against the real data in this repo.

---

## What I want designed

A new section for my personal site: **a restaurant log**. It's the third of a
family. The site already has a film log (a Letterboxd-shaped thing — diary
entries, ratings, a watchlist, stats) and a book log (reading sessions off a
Kindle, shelves, a month-in-reading card). This is the same idea pointed at
restaurants, and it should feel like it was built by the same person on the
same afternoon — but it should not look like the film log with the posters
swapped out, because it can't (see "No posters", below, which is the central
problem in this brief).

I want a design, not working code: static HTML/CSS mockups with plausible
invented data, so I can see the thing and argue with it. Everything is built
by hand as plain HTML and CSS — there is no component library, no chart
library, no Tailwind. Design accordingly. Inline SVG is fine where it earns
its place.

The invented data should look like my actual eating: heavily New York (I live
here — Sunset Park, Flushing, the East Village, Jackson Heights), with a
scatter of travel (Mexico City, Austin, LA, Tokyo). Don't fill it with
plausible-sounding chain restaurants.

## The aesthetic brief

**A California Mexican or Tex-Mex restaurant menu.**

I mean the printed object, not the theme party. The reference set is: a
laminated menu at a taqueria, a Cal-Mex chalkboard with the specials in
chalk-marker, a Tex-Mex placemat with a border pattern, hand-painted signage
over a counter, Talavera tile, butcher paper taped over yesterday's prices.
Warm, worked, a little greasy at the corners. Type that was set by someone who
owns the restaurant.

Things that would make this bad, and that I will reject on sight:

- Sombreros, maracas, cacti-with-faces, chili-pepper clip art, papel picado
  used as wallpaper to signal "Mexican" without doing any work.
- Distressed "Mexican-look" display faces used as costume — Rosewood, Fiesta,
  and anything whose entire idea is that it has a bit of dust on it.
- Emoji anywhere.
- A margarita-glass empty state.

The distinction I'm drawing: a real taqueria menu isn't *about* being Mexican,
it's about telling you what the tacos cost. Steal its **structure** — section
headers with rules under them, dot leaders running from a dish name to a price
in the right margin, small caps, a boxed special, a marginal glyph next to the
house favorites, prices set in a column that lines up — and let the warmth come
from the palette and the paper. The layout devices are the brief. The decor is
not.

### The decision I want you to make and defend

The film log is wine-red-on-dark. The book log is paper-brown-on-dark. A
Cal-Mex menu is naturally **cream paper, printed dark** — light. So:

**Does the restaurant log break the dark family, or stay in it?**

Light means committing to the printed-menu object: manila/cream ground, ink
brown, terracotta and avocado and marigold accents. It's the honest reading of
the brief, and it costs the family resemblance — this section will look like a
different site until you get to the nav.

Dark means the late-night taqueria instead of the lunch menu: a deep
chile-brown or charred-black ground with marigold and terracotta doing the
work. It keeps the three sections siblings, and it fights the brief a little.

**Show me the one you'd ship at full size, and the other as a smaller sketch of
the same one or two screens, so I can see what I'm giving up.** Then give me
the palette you chose as a named token list I can paste into CSS.

### The family it has to live with

For reference, the two existing palettes — match the *level of commitment*,
not the hues:

- **Film log** — ground `#1c0d0e`, page `#2a1214`, nav `#20100f`, rules
  `#4a2529` / `#402226`, text `#f4e8d1`, secondary `#c2a99a` / `#ddc9b4`, gold
  `#d9b45a`, hover `#f0d488` / `#fff3df`
- **Book log** — ground `#1a120a`, panels `#1f1609` / `#221809`, text
  `#f2e6cd`, secondary `#a68f6e`, tertiary `#8a745a`, gold `#cfa452`, hover
  `#ecc87c`, rules `#2b2013` / `#33261a` / `#45341f`

Both sections use **Archivo** for UI, labels and numbers, and **Newsreader**
(serif) for anything that reads as prose. Keep Archivo for the interface —
counts, chips, nav, tabular figures — so the three sections agree on what a
control looks like. **You may add exactly one display face** for menu headers,
loaded from Google Fonts. Candidates worth trying: Rye, Sancreek, Bevan, Alfa
Slab One, Ultra, Chicle, Bree Serif, Zilla Slab; for a hand-painted accent,
Yellowtail or Berkshire Swash. Pick one, use it with discipline, and say why.

### The structural vocabulary it inherits

These are the site's existing furniture. Reuse the anatomy, restyle the skin:

- A **top nav** of text tabs spanning the viewport (Home · About · Projects ·
  Films · Books · Subway · and now this one), with the active tab underlined
  in the accent colour, and a primary button pinned right — on the film log
  it's `+ Log film`.
- A **288px sidebar**: a two-line serif wordmark, a one-line accent subtitle
  ("47 films this year"), a rule, then a column of nav rows that are each a
  label on the left and a **count on the right**, separated by hairlines.
- A **main column** of sections, each with a `sec-head` — a title on the left,
  and on the right either a count, a stat, or a `See more →` link.
- **Detail pages** open with a topbar: `← Jason's restaurant log` on the left,
  a section tag on the right, then a title block.
- Filter controls are **chips** (`aria-pressed` toggles), **pills** for sort
  order, dual **range sliders** for numeric facets, and `<details>` disclosure
  panels for the heavy stuff.

## The pages

Nine screens, at two fidelities. **Full fidelity** for the four that carry the
section; **one screen each, lower fidelity** for the rest — enough to prove the
system extends, not enough to spend your whole budget on.

### Full fidelity

**1. The landing page — `/restaurants`.** Sidebar + main. The sidebar wordmark,
a "N restaurants this year" line, and nav rows with counts for: Restaurants ·
Diary · To try · Stats · Month in review. The main column, in order:

- **Top four favourites.** Four of them, fixed, hand-picked and ranked.
- **Recently visited.** The last four diary entries.
- **Recently added to the to-try list.** The last four.

The film log's version of this page is three rows of four poster tiles. You
don't have posters. See below.

**2. Restaurants — the list view.** Everywhere I've eaten, one row or tile
each, filterable and sortable. This is where a menu's typographic structure has
the most to offer: a list of names, each with a cuisine, a price, a
neighbourhood and a rating, is *already a menu*. Consider what dot leaders and
a right-hand price column buy you, and consider what they cost when the same
list has to work at 380px wide.

**3. Restaurants — the map view.** Same collection, same filters, plotted. See
"The map" below — it has more sharp edges than anything else here.

**4. A restaurant detail page.** The place, not a visit. It carries: name,
cuisine (possibly several), price band, location, my rating (an average across
visits, plus each visit's own), the current return verdict, whether it's
hearted, links out (Google Maps, the restaurant's own site, Yelp, Beli), every
diary entry I've written about it, and every photo I've taken there. Design for
a place I've been to **once** and for one I've been to **eleven times** — the
second is the interesting one, and the first is the common one.

### Lower fidelity — one screen each

**5. The diary.** Reverse-chronological visits, grouped by month. The film
log's diary is a dense table-ish list; this one has photos to contend with.

**6. A diary entry detail page.** One visit: the restaurant, the date, photos
with captions, the rating, the verdict, the heart, the revisit mark, who I was
with, the review, the tags.

**7. To try.** Same two views as Restaurants — list and map — but the rows have
no rating, no verdict, no photos, and no history. Mostly a name, a
neighbourhood, and why I want to go. Show me how the same components survive
having two thirds of their content removed, and whether the map means something
different when every pin is a place I haven't been.

**8. Stats — a stub.** I'm not building this yet, so design the honest stub: a
page that says "not yet" without looking broken or unfinished. **Then, small,
sketch where it goes** — cuisine breakdown, price mix, a neighbourhood/city
distribution, visits over time. The sketch's job is to prove the data model
below can actually answer those questions. If it can't, say so.

**9. Month in review.** The film and book logs each have a shareable card: a
1080px-wide artboard, a calendar grid, four summary figures, exported to 9:16,
4:5 and 1:1. The restaurant version has a problem — a good month is eight
meals, not thirty, and there are no posters to tile. But it has something the
others don't: **my own photographs**. Design the card around that.

## The data model

This is settled — design to it. If something here is wrong, tell me, but tell
me at the end rather than designing around it.

### A restaurant

| field | notes |
| --- | --- |
| `name` | |
| `cuisines` | **Multi-valued.** A place is legitimately "Mexican, Tex-Mex" or "Sichuan, Hot pot". Controlled list with a free-text escape hatch. |
| `price_band` | `$` `$$` `$$$` `$$$$`. Four steps, no half steps. |
| `neighborhood` | **Nullable, and null a lot.** See below. |
| `city`, `state_region`, `country` | Always present. |
| `lat`, `lng` | Always present. Drives the map. |
| `google_place_id` | Not displayed. Builds the Google Maps link. |
| `website_url`, `yelp_url`, `beli_url` | All nullable, and often null. |
| `favorite_rank` | 1–4, or null. Drives the top-four block. |

**On neighbourhood:** I want it, geocoders are unreliable about it, and it is
strongly present in New York and largely absent everywhere else. So the design
has to read well both as "Sunset Park, Brooklyn" and as plain "Austin, TX",
and the fallback must not look like a missing field — it should look like the
level of detail that place warrants.

**On location, generally:** these come from an open geocode that I confirm by
hand at log time, so they're accurate but the *granularity* varies. City,
state/region and country are the guaranteed floor.

### A diary entry — one visit

| field | notes |
| --- | --- |
| `restaurant` | |
| `visited_on` | A date, not a timestamp. |
| `photos[]` | Zero to many, each with an **optional** caption. |
| `rating` | 0.5–5.0 stars in half steps. Nullable. |
| `verdict` | The six-step return scale. Nullable. |
| `hearted` | A boolean, its own control, independent of the verdict. |
| `revisit` | A boolean — "I'd been here before". The film log's ↻ rewatch mark. |
| `friends[]` | Who I ate with. Free text, autocompleted from past entries. |
| `review` | Prose. Often absent, occasionally four paragraphs. |
| `tags[]` | Free text, autocompleted. |

### The return verdict

A six-step scale answering **"would I go back?"**, best to worst. It is the
signature primitive of this section — films get a heart and a rewatch arrow,
books get a shelf; this gets a ladder.

| verdict | what it means |
| --- | --- |
| **Definitely return** | I'd get this food again |
| **Worth returning** | I liked it, but circumstances make me unlikely to choose it myself |
| **Try something else** | Didn't love what I ordered, but the restaurant itself seems worth another attempt |
| **Happy to go** | Would go again if someone else suggested it |
| **No return** | Would not go again |
| **Avoid** | Would actively recommend that others not go |

The heart is **not** a seventh step. It's a separate button that can sit on any
verdict, including a low one, and it means something different — love, not
likelihood.

**One thing to know before you design the control:** the two ends of this scale
are strictly ordered, and the middle isn't. "Worth returning" and "Happy to go"
are close to the same statement — positive, but I won't be the one picking the
place — and "Try something else" isn't on the return-likelihood axis at all; it
says the problem was my order, not the restaurant. So the compact badge **must
not** render as a filled progress track or an N-of-6 meter, because that would
claim an ordering the middle three don't have.

Design them instead as **six marks**: a distinct glyph per verdict, in the
section's visual language — the marginal symbols a menu puts next to the house
specials and the spicy dishes are the right reference. Drawn, not emoji. They
need to read at badge size next to a restaurant name, and to line up as a
legible set when all six are shown together in the composer.

If, having designed it, you think the scale itself should change — merging the
two near-duplicates, or lifting "Try something else" out into its own flag —
say so in the rationale. Don't silently redesign it; I want the argument.

## The sharp edges

These are the parts I expect to be hard. Solve them explicitly; don't let them
fall out of a layout decision made for another reason.

### 1. No posters

**This is the central problem.** The film log is a grid of poster tiles and the
book log is a grid of covers. Both get their entire visual density for free
from someone else's artwork, in a consistent aspect ratio, always present.

A restaurant has no canonical image. What it has:

- **A name**, which is often the best thing about it and is frequently long
  ("Taquería Ramírez", "Xi'an Famous Foods", "Casa Enrique").
- **My own photographs**, which exist only after I've been, are wildly
  inconsistent (a dark phone shot of a taco, a wide shot of a dining room, a
  portrait of a menu board), and are entirely absent for anything on the to-try
  list.
- **A cuisine, a price and a place**, which are short strings that a menu would
  set beautifully and a poster grid would waste.

So: **what is the tile?** Four favourite restaurants have to fill the same
visual slot four poster tiles fill on the film log, and the answer is probably
typographic rather than photographic — which is exactly why the menu brief is
the right one. Work this out first; most of the rest of the section follows
from it. Show the tile with a photo and without, with a 6-character name and a
28-character one.

### 2. Three rating signals on one entry

Every visit can carry a **five-star half-step rating**, a **six-step verdict**,
and a **heart**. That's three overlapping opinions, and a naïve design gives me
three rows of widgets stacked in a modal, which is awful.

They're not redundant — stars are "how good was it", verdict is "will I
return", heart is "do I love it" — but the design has to make that legible
rather than making me read a manual. Establish a hierarchy. Decide which one is
the headline on a tile, which survives into a map pin, and which only appears
on the entry itself.

And design the verdict control **three times**: as an input in the composer
(where the labels are visible and I'm choosing), as a compact read-only badge
in a list row or tile (where it's a glyph and a tooltip), and at full size on
the entry page. Six steps is a lot to render in 40px. That's the job.

### 3. The map

Both Restaurants and To try have a **list ⇄ map toggle**. The map is MapLibre
GL with a basemap style I author myself, which means:

**You get to specify the basemap colours.** Hand me a named list — land, water,
roads (major/minor), parks, building fill, boundaries, label text, label halo —
in the palette you chose. This is the part of the map that decides whether it
looks like part of a menu or like an iframe someone dropped in. Take it
seriously; a cream-and-terracotta basemap with hand-set labels is the whole
opportunity here.

For the mockups, fake the map as an image or SVG. I only need the chrome, the
pins, the popups and the colour spec.

The genuine problems:

- **The viewport is not solvable by fitting bounds.** 80% of my pins are in a
  dense New York cluster, and the rest are in Mexico City, Austin, LA and
  Tokyo. Fit-to-bounds gives me a world map with five specks. Defaulting to
  New York silently hides a fifth of the collection. Decide what happens on
  load, and design whatever affordance tells me the rest of the world is out
  there. A city switcher is one answer; there are better ones.
- **Dense clusters.** Twelve restaurants on eight blocks of Sunset Park. Design
  the clustered state and the zoomed-in state, and what a cluster badge shows.
- **The pin has to carry something.** Rating? Verdict? Just "visited vs to
  try"? Pick, and justify. Pins in the to-try map mean something different from
  pins in the visited map — that difference should be visible without a legend,
  and if you need a legend, design it.
- **Filters are shared.** Toggling list→map keeps every active filter. Design
  the filter bar so it reads the same in both, and show the map with three
  filters active.
- **Mobile.** A map on a phone wants full height, which leaves nowhere for the
  list. Solve it.

### 4. Photos

New to this site — neither existing section has user photography. Design for:

- **Zero** photos on an entry, which is common and must not look like a
  failure.
- **One** photo, which is the most common non-zero case.
- **Three**, and **nine**.
- **Mixed orientation** in the same entry — phone portraits next to landscape
  shots. Do not design a grid that only works if everything is 4:3.
- **Captions that are usually absent.** A caption is the exception. A layout
  that reserves space for one will look empty most of the time.

And on the restaurant detail page: photos aggregated across eleven visits, which
is a different problem from photos within one visit. Say how they're grouped.

### 5. Sparse and day-one states

Design these explicitly, because they're what I'll actually be looking at for
the first month:

- **Day one.** Zero restaurants, zero diary entries, an empty top-four block,
  three things on the to-try list. The landing page still has to look composed
  and not like a form I failed to fill in.
- **Two favourites, not four.** The top-four grid with holes in it.
- **A restaurant with no photos, no review, no rating** — just a name, a place
  and a verdict. This is a real and frequent entry.
- **A restaurant visited eleven times**, where the detail page is mostly
  history.

### 6. Cuisine is multi-valued and long-tailed

A place can carry two or three cuisines, and across a hundred restaurants
there will be sixty distinct values with a long tail of one-offs. That affects
the filter UI (a flat list of sixty chips is unusable), the tile (where two
cuisines might not fit), and the eventual stats page (where the tail eats the
chart). Say how you'd handle each.

## Constraints

- **Mobile matters.** I read this section on a phone standing outside a
  restaurant deciding whether I've been there. The list view and the map view
  are both phone-first cases, and the restaurant detail page more so.
- Plain HTML and CSS, hand-built. No component or chart library.
- Hover/tap on anything that encodes data should tell me something exact.
- Keep interface type in Archivo so the section's controls agree with the rest
  of the site; the display face is for menu headers and the wordmark.
- The section is single-user: I'm the only person who writes, everyone can
  read. Owner-only affordances (the log button, edit links, the composer) need
  a visible-but-quiet treatment, the way `+ Log film` sits in the film log's
  nav.

## What to hand back

1. **A single self-contained HTML file** with every mockup in it, on your
   chosen palette and fonts, each screen labelled. Full fidelity for the four
   named above, one screen each for the other five.
2. **The palette decision** — the one you'd ship at full size, the other as a
   smaller sketch of one or two screens.
3. **A named CSS token list** for the palette, and a second one for the map's
   basemap colours.
4. **The verdict control in all three sizes**, and the tile with and without a
   photo, at short and long names.
5. **A short written rationale.** A paragraph each, not an essay: the light/dark
   decision, what you made the tile out of given there are no posters, how the
   three rating signals are ranked, and what happens on the map's first load.
