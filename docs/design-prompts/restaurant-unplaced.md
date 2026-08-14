# Design prompt — placing a restaurant that has no point on the map

Paste everything below the rule into Claude Design, in the project that holds
`Jason's Restaurant Log.dc.html`. Unlike the histogram prompt, this one asks for
**edits made directly in that file** — a new state prop, a new panel on the
Restaurant screen, and a new dialog — rather than a mockup to compare against.

The pattern being ported is the book detail page's *unmatched* state
(`Book.dc.html`, the `unmatched` option on its `book` enum): a dashed
invitation where the missing metadata would have been, plus a match panel that
searches an outside catalogue and writes the result back.

---

## What I want built

The restaurant detail screen has no way to fix a restaurant that was added
**without a location**. I want one, in the shape the book page already uses for
a book that was never matched to Open Library.

Work in `Jason's Restaurant Log.dc.html` — the nine-screen file. Not
`Restaurant Log.dc.html`, which is the spec sheet.

1. Add the **unplaced** state to the props panel, with a fixture, so it can be
   switched to and looked at like every other state on that screen.
2. Add the **invitation** — the always-visible thing on the Restaurant screen
   that says this place has no point and offers to find one.
3. Add the **place panel** — the dialog that searches, shows candidates, and
   confirms one. The book's match panel is the model.
4. Add the quiet entry point for a place that *is* located but located wrongly
   — the analogue of the book page's `wrong edition?`.

## Where in the file

- **The screen** is `screen: "Restaurant"` — the `isPlace` block, artboard
  labelled *Restaurant detail*. Header, verdict history, photographs, every
  visit, and a right rail with the verdict/rating/visits sidecar and the Owner
  box.
- **The fixture** is the `place` object in the vals function, currently a
  ternary pair on `bare`: *Ba Xuyên*, Vietnamese, `$`, Sunset Park, eleven
  visits — against *Bocca Nuova*, Italian, `$$$`, Carroll Gardens, one visit.
- **The state prop is not `placeHistory`.** Its `Bare entry` option is a
  different thing: one visit with no rating, no review, no photos. Unplaced has
  to be able to cross with visit history — *unplaced × eleven visits* is a real
  page — so add a **separate prop** (something like `location: Placed /
  Unplaced`) rather than a fourth option on that enum. If you disagree, say so
  and show why.
- **The dialog** should become a third option on the existing `dialog` enum
  (`Closed` / `Log meal` / `Add to to-try`), so it is reachable from the props
  panel the same way the other two are.
- **The greyed-link idiom already exists** in the header's link row: Google
  Maps, Website and Beli render as links, Yelp renders in `#bda98a` with
  `title="No Yelp link on record"`. That is the file's existing vocabulary for
  *nothing on record*, and the location line needs something in the same
  register.
- **The suggestion-row anatomy already exists** in the Log meal dialog: a
  `#fdf7e8` list on a `#2f1e12` border, rows of bold name / muted meta /
  right-aligned mono tail, hover `#f0e2c2`. Reuse it for candidate hits. But
  note what it currently does — it searches the **existing restaurant list**
  and offers `"typed name" · new place · add`. There is no geocoder anywhere in
  this file yet, so the hit list, and everything that makes a hit different
  from a restaurant you already have, is new.
- **The Owner box** in the right rail (`+ Log another visit`, `Edit this
  place`, `Set favourite rank`) is a candidate home for the entry point, and
  worth weighing against the body — see decision 1.
- **There is no `viewer` prop in this file**, unlike `Book.dc.html`. Don't add
  one for this. Draw the owner's view, as the file already does, and say in the
  rationale what a visitor would see instead.
- Your own fixture is the argument for one of the constraints below: OSM files
  **Ba Xuyên** under *Dyker Heights*, and the file says *Sunset Park, Brooklyn*
  — which is what anyone who goes there says. The geocode is a suggestion; the
  field is the record.

## How the book page does it, exactly

So the two read as the same idea, not two solutions:

- **In the metadata column**, a panel with a 1px dashed border and 10px radius:
  an italic Newsreader line (*"Nothing is known about this book yet."*), then
  the raw Kindle filename in a monospace inset box — the thing on record, shown
  as evidence — then a primary button: *"Find this book on Open Library."*
  The shipped build also offers an ISBN field *above* the search button,
  because a number needs no query and no choosing between editions.
- **For a matched book**, all of that is gone and there is one 11.5px
  underlined `wrong edition?` button at the end of the metadata row.
- **The panel** is a centred overlay, max 620px, with three states in one body:
  a query field with result rows (title, author, year, pages — "the year and
  page count are how you tell them apart"); a *confirming* state showing the
  picked edition with a `Pick a different edition` link back, plus editable
  **Shown as** and **Author** fields and a note that the Kindle's filename
  stays underneath as the identifier; and a no-results line that explicitly
  gives permission to give up: *"Nothing on Open Library matches that. Try the
  author alone, or leave it unmatched — the reading log works without it."*
- The footer is Cancel on the left, and the confirm button (`Link this
  edition`) appears **only** in the confirming state.

## What "unplaced" means here, and its sharp edges

A restaurant row carries `lat`/`lng` that are nullable on purpose: a place can
be logged before it is placed. Everything below is the real database, not a
hypothetical.

1. **34 of 84 restaurants are unplaced.** Every one came through the bulk
   to-try importer, which takes a list of names — a Google Maps saved list
   through Takeout, a note, a text someone sent you — looks each one up, and
   adds the ones it can't place anyway. So the unplaced page is a real,
   frequent page, and it looks like: *Sailor & Siren*, *Tlayuda Oaxaqueña SR
   San Pablo*, *Benfaremo — The Lemon Ice King of Corona*, *Laser Wolf
   Brooklyn*, *Chef Paul Restaurant*. Use names of that kind in the fixture,
   not another Bocca Nuova.

2. **Unplaced is never only a missing pin.** All 34 also have: no
   neighbourhood, no cuisine, no price band, and none of the four links — so
   the header's whole facts row (`Vietnamese · $ · Sunset Park, Brooklyn`) is
   empty except for the part that is worse than empty, which is 3.

3. **The city is a fabrication, and the header states it as fact.** `city` is
   NOT NULL, and a place added by name alone is inserted as **New York** to
   keep the composer's fast path open. All 34 pages currently assert a city
   nobody confirmed. **Decide what the header does with an unconfirmed city** —
   that decision is part of this work, not a follow-up.

4. **Unplaced means absent from the map.** The map screen filters to rows with
   both coordinates, so an unplaced restaurant is invisible there and its city
   contributes nothing to the city rollup. That absence is the actual cost of
   this state, and the invitation may as well say so.

5. **Today every unplaced place is a to-try place with zero visits**, so the
   common page is nearly empty: the to-try block with its reason, no visits, a
   sidecar reading *None recorded / no rating / 0*. But the visit composer's
   fast path can also create a place from a typed name, so **a place with
   eleven visits and no point is reachable** and must not break. On that page
   the invitation cannot be the main event. The two loudnesses are a thing to
   design, not to average.

6. **A place that is placed can still be placed wrong.** The importer and the
   composer both refuse an area centroid, but a wrong-but-precise hit — the
   other Tacos El Bronco — is entirely possible, and the `wrong edition?`
   analogue is how it gets fixed.

## The lookup that already exists

The panel has a real backend; design to its actual behaviour.

- One route returns up to ~5 hits from **Nominatim / OpenStreetMap**.
  Restaurants are first-class named objects there, which is the whole reason it
  isn't the map vendor's geocoder — that one returns villages in Spain for
  "Wu's Wonton King".
- **You search by NAME, not address** — you know what a place is called, and
  you're usually adding it because someone said the name out loud. A "where"
  hint is appended to disambiguate, which is what separates the four Tacos El
  Bronco from each other. So the panel wants a name and a where; work out
  whether that's one field or two.
- Each hit carries: its own name (properly spelled and accented — the half you
  can't type on a phone), a full display line, lat/lng, neighbourhood, city,
  state/region, country, OSM's classification (`restaurant`, `fast food`,
  `cafe`), any cuisines it records, a short address, and **`precise`**.
- **`precise` is the load-bearing flag.** False means the coordinates are the
  centre of an area — a neighbourhood, a boundary — not the door. Those hits
  are still offered, labelled *"no exact point"*, because their **names** are
  worth taking even when their point isn't. So a confirm can legitimately fill
  in the location text and still leave the place unplaced. Design that outcome;
  it has no book equivalent and it is the interesting one.
- Two failure modes are ordinary, not exceptional: **no hit** (the composer
  says *"No exact match — it will be added without a point on the map"*) and
  **the geocoder unreachable**. Neither may block anything.
- Cuisine is filled from OSM **only when the field is empty** — a typed cuisine
  is a choice and OSM's is a guess.

Everything a confirm would write already exists on the place update route:
name, cuisines, price band, neighbourhood, city, state/region, country, lat,
lng. Nothing has to be invented server-side, so design for what the form should
*ask*, not for what the API permits.

## Decisions I want you to make and defend

Short paragraphs, not essays. These are the ones I don't want defaulted:

1. **Where the invitation lives, and how loud.** The book puts it in the
   metadata column. Here the natural site is the header, because the header is
   where the lie about the city is being told — but the header is the one part
   of this screen that must not become a form, and there is an Owner box in the
   rail already collecting exactly this kind of control. Whatever you choose
   has to survive the eleven-visit version of the page, where the invitation is
   a footnote rather than the content.

2. **What the header says when the city was never confirmed.** Suppress the
   line, mark it as unverified in the greyed-Yelp register, or leave "New York"
   and let the invitation carry the correction. Pick one and say why.

3. **Dialog or inline.** The book uses a modal because matching is a
   digression. This file's Log meal dialog already does place-picking inline
   with a suggestion list under the field, on this palette. Reusing that costs
   the screen some calm; the dialog costs the family a duplicate pattern. Ship
   one, sketch the other.

4. **What the confirming step asks for.** The book asks two fields (shown as,
   author) and states what stays underneath as the identifier. The restaurant
   equivalent is at most name / where / cuisine, and OSM has opinions about all
   three. Decide which are pre-filled, which are blank, and what the
   "underneath" note says here — a restaurant has no filename, so what is the
   evidence line?

5. **The area-only hit.** A hit with `precise: false` fills the words and not
   the point. Say how the row is marked in the list, and what the page looks
   like after confirming one: it is *more* known than before and still not on
   the map. Does the invitation stay, change, or go?

6. **The escape hatch when OSM has nothing.** A new restaurant may simply not
   be in OpenStreetMap. Options: leave it unplaced with a good sentence (the
   book's move), let the location text be typed by hand without a point, or
   accept a pasted Google Maps URL / coordinate pair. Recommend one — and if
   it's the last, show it, because it changes the panel's shape.

## The visual language

**This section is the light one** — cream paper, not the film log's wine-red or
the book log's brown. Use the file's existing tokens; don't introduce near-misses:

- Ground `#f7eed9`, panel stock `#efe1c3`, card `#fdf7e8`, wash `#fbf3e1`,
  sunk/locked field `#f0e2c2`, disabled `#e0d1b2`
- Ink `#2f1e12`, prose `#4a3626`, secondary `#6d5740`, labels `#8d7357`,
  faint `#a8927a`
- Rules `#c4ad86`, `#ddcaa6`, `#e3d5b6`, `#eadfc4`; **dashed `#b09873`** — the
  dashed-border idiom the book's invitation uses already has a token here
- Terracotta `#b34328` (primary), deep `#8e3220` (link ink dark enough for
  paper), marigold `#d38b1a` (stars), avocado `#556b2a`, chile `#a83a22`
- **Ultra** for the name and section heads only — it is the one display face
  and it is not a UI face; **Archivo** for every control, label, count and
  chip; **Newsreader** for prose; `ui-monospace` for tabular figures
- Reuse the screen's furniture rather than inventing near-copies: the
  `#fdf7e8`-on-`#c4ad86` box, the small-caps label, the section head with its
  rule, the dotted leader, the dialog's field and suggestion list.

Mirroring the book's *anatomy* is the goal; mirroring its browns is not.

## States to show

Reachable from the props panel or by clicking, not a gallery of stills:

1. **Unplaced, to-try, no visits** — the common page, and the emptiest.
2. **Unplaced × eleven visits** — the invitation as a footnote on a full page.
3. **Placed** — invitation absent, only the quiet "wrong location?" entry.
4. **The panel: searching** — results including at least one `precise: false`
   area hit, marked as such, and one near-duplicate pair that the "where" hint
   is what separates.
5. **The panel: confirming** — fields pre-filled from the hit, editable.
6. **The panel: nothing found**, and **the geocoder unreachable** — with the
   sentence that gives permission to leave it unplaced.
7. **After confirming an area-only hit** — located in words, still unpinned.
8. **Phone width** for 1, 4 and 5. The to-try list gets browsed on a phone more
   than anywhere else, and the panel is where that hurts.

## Constraints

- The site's rule holds throughout: **the geocode is a suggestion and the field
  is the record.** Nothing may write a value the owner can't then edit.
- Never pin a restaurant to a centroid. If a design makes that easy by
  accident, it's the wrong design.
- Scope is the Restaurant screen and its new dialog. The map screen's
  `31 of 96` counter is where the unplaced ones could be admitted to globally —
  note it if you like, but don't build it here.
- No new fonts, no new accent colours, no new display face. A static sketch of
  a map preview is fine if you argue it earns the space.
- Keep the copy in the house voice: plain, specific, willing to say what isn't
  known. *"No exact match — it will be added without a point on the map"* is
  the register.

## What to hand back

1. The edited `Jason's Restaurant Log.dc.html`, with the new prop and fixture,
   the invitation, the dialog and the "wrong location?" entry wired to state so
   the states above can be clicked through.
2. The alternative to whichever of dialog-vs-inline you didn't ship, as a small
   static sketch in the same file, clearly labelled.
3. A short rationale covering decisions 1–6 — a paragraph each, and where a
   decision changed the header or the sidecar, say what it changed.
