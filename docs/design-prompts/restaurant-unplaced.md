# Design prompt — placing a restaurant that has no point on the map

Paste everything below the rule into Claude Design, with the restaurant detail
page open. Unlike the histogram prompt, this one asks for **edits made directly
in the restaurant detail `.dc.html`** — a new state on the existing state enum,
a new panel in the page, and a new overlay — rather than a fresh mockup file to
compare against.

The pattern being ported is the book detail page's *unmatched* state
(`Book.dc.html`, the `unmatched` option on the `book` enum): a dashed
invitation where the missing metadata would have been, plus a match panel that
searches an outside catalogue and writes the result back.

---

## What I want built

The restaurant detail page — the **place** page, the one with the verdict
history, the photographs and the every-visit list; not the diary entry — has no
way to fix a restaurant that was added **without a location**. I want one, in
the shape the book page already uses for a book that was never matched to Open
Library.

Work in the restaurant detail `.dc.html` itself:

1. Add an **unplaced** option to the page's state enum, with a fixture, so the
   state can be switched to and looked at like every other state on that page.
2. Add the **invitation** — the always-visible thing on the page that says this
   place has no point and offers to find one.
3. Add the **place panel** — the overlay that searches, shows candidates, and
   confirms one. The book's match panel is the model.
4. Add the quiet entry point for a place that *is* located but located wrongly
   — the analogue of the book page's `wrong edition?`.

## How the book page does it, exactly

So the two read as the same idea, not two solutions:

- **In the header column**, where the metadata would be, a panel with a
  1px dashed `#45341f` border and 10px radius: an italic Newsreader line
  (*"Nothing is known about this book yet."*), then the raw Kindle filename in
  a monospace inset box — the thing on record, shown as evidence — then, for
  the owner only, a gold primary button: *"Find this book on Open Library."*
  In the shipped build there's also an ISBN field offered *above* the search
  button, because a number needs no query and no choosing.
- **For a matched book**, all of that is gone and there is one 11.5px
  underlined `wrong edition?` button at the end of the metadata row.
- **The panel itself** is a centred overlay, max 620px, with three states in
  one body: a query field with result rows (title, author, year, pages —
  "the year and page count are how you tell them apart"); a *confirming* state
  showing the picked edition with a `Pick a different edition` link back, plus
  editable **Shown as** and **Author** fields and a note that the Kindle's
  filename stays underneath as the identifier; and a no-results line that
  explicitly gives permission to give up: *"Nothing on Open Library matches
  that. Try the author alone, or leave it unmatched — the reading log works
  without it."*
- The footer is Cancel on the left, and the confirm button (`Link this
  edition`) appears **only** in the confirming state.

## What "unplaced" means here, and its sharp edges

A restaurant row carries `lat`/`lng` that are nullable on purpose: a place can
be logged before it is placed. Everything below is the real data, not a
hypothetical.

1. **34 of 84 restaurants are unplaced.** Every one of them arrived through the
   bulk to-try importer, which takes a list of names — a Google Maps saved list
   through Takeout, a note, a text someone sent you — looks each one up, and
   adds the ones it can't place anyway. So the unplaced page is a real,
   frequent page, not an edge case, and it looks like: *Sailor & Siren*,
   *Tlayuda Oaxaqueña SR San Pablo*, *Benfaremo — The Lemon Ice King of
   Corona*, *Laser Wolf Brooklyn*, *Chef Paul Restaurant*. Use names of that
   kind in the fixture, not "Restaurant A".

2. **Unplaced is never only a missing pin.** All 34 also have: no
   neighbourhood, no cuisine, no price band, and none of the four links
   (Website, Yelp, Beli have nothing to point at; Google Maps still works
   because it falls back to a name search). The location line is the loudest
   problem — see 3.

3. **The city is a fabrication, and the header states it as fact.** `city` is
   NOT NULL, and a place added by name alone is inserted as **New York**
   because the fast path has to stay open. The header renders that through the
   ordinary location line, so all 34 pages currently assert a city nobody
   confirmed. A page that admits it doesn't know where the place is beats a
   page that quietly says New York. **Decide what the header does with an
   unconfirmed city** — that decision is part of this work, not a follow-up.

4. **Unplaced means absent from the map.** The places index filters to rows
   with both coordinates, so an unplaced restaurant is invisible there and its
   city contributes nothing to the city rollup. That absence is the actual cost
   of this state and the invitation may as well say so.

5. **Today every unplaced place is a to-try place with zero visits**, so the
   common page is nearly empty: the to-try block with its reason, "Not been
   yet." where the visits go, and a sidecar reading *None recorded / no rating
   / 0*. But the visit composer's fast path can also create a place from a
   typed name, so **a place with eleven visits and no point is reachable** and
   must not be broken. On that page the invitation cannot be the main event.
   The two loudnesses are a thing to design, not to average.

6. **A place that is placed can still be placed wrong.** The importer and the
   composer both refuse an area centroid, but a wrong-but-precise hit — the
   other Tacos El Bronco — is entirely possible, and the `wrong edition?`
   analogue is how it gets fixed.

## The lookup that already exists

The panel has a real backend; design to its actual behaviour.

- One route, `GET /api/restaurants/geocode?q=…`, returns up to ~5 hits from
  **Nominatim / OpenStreetMap**. Restaurants are first-class named objects
  there, which is the whole reason it isn't the map vendor's geocoder.
- **You search by NAME, not address** — you know what a place is called, and
  you're usually adding it because someone said the name out loud. Whatever is
  in a "where" hint gets appended to disambiguate, which is what separates the
  four Tacos El Bronco from each other. The panel therefore wants a name field
  and, probably, a where field; work out whether that's one input or two.
- Each hit carries: its own name (properly spelled and accented — the half you
  can't type on a phone), a full display line, lat/lng, neighbourhood, city,
  state/region, country, OSM's classification (`restaurant`, `fast food`,
  `cafe`), any cuisines it records, a short address, and **`precise`**.
- **`precise` is the load-bearing flag.** False means the coordinates are the
  centre of an area — a neighbourhood, a boundary — not the door. Those hits
  are still offered by the composer, labelled *"no exact point"*, because their
  **names** are worth taking even when their point isn't. So a confirm can
  legitimately fill in the location text and still leave the place unplaced.
  Design that outcome; it has no book equivalent and it is the interesting one.
- **The geocode is a suggestion, not an answer.** OSM files Ba Xuyên under
  Dyker Heights when everyone who goes there says Sunset Park. Every field stays
  editable after a pick — that is settled policy, and it is why the panel needs
  a confirming step rather than writing straight through on click.
- Two failure modes are ordinary, not exceptional: **no hit** (the composer
  says *"No exact match — it will be added without a point on the map"*) and
  **the geocoder unreachable**. Neither may block anything.
- Cuisine is filled from OSM **only when the field is empty** — a typed cuisine
  is a choice and OSM's is a guess.

Everything the confirm needs to write already exists on the place PATCH route:
name, cuisines, price band, neighbourhood, city, state/region, country, lat,
lng. Nothing has to be invented server-side, so design for what the form should
*ask*, not for what the API permits.

## Decisions I want you to make and defend

Short paragraphs, not essays. These are the ones I don't want defaulted:

1. **Where the invitation lives, and how loud.** The book puts it in the
   metadata column under the description. Here the natural site is the header,
   because the header is where the lie about the city is being told — but the
   header is also the one part of this page that must not become a form. And
   whatever you choose has to survive the eleven-visit version of the same page,
   where the invitation is a footnote rather than the content.

2. **What the header says when the city was never confirmed.** Suppress the
   line, mark it as unverified, or leave "New York" and let the invitation
   carry the correction. Pick one and say why.

3. **Panel or inline.** The book uses a modal because matching is a
   digression. The visit composer already does this lookup inline, with a
   suggestion list under the field, and its idiom exists on the light palette
   already. Reusing that costs the page some calm; the modal costs the family a
   duplicate pattern. Ship one, sketch the other.

4. **What the confirming step asks for.** The book asks for two fields (shown
   as, author) and states what stays underneath as the identifier. The
   restaurant equivalent is at most name / where / cuisine, and OSM has
   opinions about all three. Decide which are pre-filled, which are blank, and
   what the "underneath" note says here — a restaurant has no filename, so
   what is the evidence line?

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
the book log's brown. A printed Cal-Mex menu: manila ground, ink brown, and
three accents a two-colour press could have run. Use the page's existing tokens:

- Ground `#f7eed9`, panel stock `#efe1c3`, card `#fdf7e8`, wash `#fbf3e1`,
  sunk/locked field `#f0e2c2`, disabled `#e0d1b2`
- Ink `#2f1e12`, prose `#4a3626`, secondary `#6d5740`, labels `#8d7357`,
  faint `#a8927a`
- Rules `#c4ad86`, `#ddcaa6`, `#e3d5b6`, `#eadfc4`; **dashed `#b09873`** — the
  dashed-border idiom the book's invitation uses already has a token here
- Terracotta `#b34328` (primary button, active tab), deep `#8e3220` (link ink
  dark enough for paper), marigold `#d38b1a` (stars), avocado `#556b2a`,
  chile `#a83a22`
- **Ultra** for menu headers and the wordmark only — it is the one display
  face and it is not a UI face; **Archivo** for every control, label, count and
  chip; **Newsreader** for prose; `ui-monospace` for small tabular figures
- Reuse the page's existing furniture rather than inventing near-copies: the
  boxed panel, the small-caps label, the section head, the pill buttons, the
  composer's suggestion row.

Mirroring the book's *anatomy* is the goal; mirroring its browns is not.

## States to show

Every one of these should be reachable from the state enum or from clicking
around the page — not a gallery of static screenshots.

1. **To-try, unplaced** — the common page. Nearly empty: to-try block, "Not
   been yet.", a sidecar with nothing in it, and the invitation.
2. **Visited eleven times, unplaced** — the invitation as a footnote on a full
   page.
3. **Placed** — invitation absent, only the quiet "wrong location?" entry.
4. **The panel: searching** — with results that include at least one
   `precise: false` area hit, marked as such, and one near-duplicate pair that
   the "where" hint is what separates.
5. **The panel: confirming** — fields pre-filled from the hit, editable.
6. **The panel: nothing found**, and **the geocoder unreachable** — with the
   sentence that gives permission to leave it unplaced.
7. **After confirming an area-only hit** — located in words, still unpinned.
8. **Visitor, unplaced** — none of the owner controls. Say what, if anything, a
   visitor is told.
9. **Phone width** for 1, 4 and 5. The to-try list gets browsed on a phone
   more than anywhere else, and the panel is where that hurts.

## Constraints

- Owner-only, like every other control on this page. A visitor sees no
  invitation and no entry point.
- The site's rule holds throughout: **the geocode is a suggestion and the field
  is the record.** Nothing may write a value the owner can't then edit.
- Never pin a restaurant to a centroid. If a design makes that easy by
  accident, it's the wrong design.
- No new fonts, no new accent colours, no chart or map library — a static
  mockup of a map preview is fine if you argue it earns the space.
- Keep the copy in the house voice: plain, specific, willing to say what isn't
  known. "No exact match — it will be added without a point on the map" is the
  register.

## What to hand back

1. The edited restaurant detail `.dc.html`, with the new enum option and
   fixture, the invitation, the panel and the "wrong location?" entry all
   wired to state so the states above can be clicked through.
2. The alternative to whichever of panel-vs-inline you didn't ship, as a small
   static sketch in the same file, clearly labelled.
3. A short rationale covering decisions 1–6 — a paragraph each, and where a
   decision changed the header or the sidecar, say what it changed.
