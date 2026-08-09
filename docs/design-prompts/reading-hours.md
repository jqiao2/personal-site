# Design prompt — the hour-by-hour histogram

Paste everything below the rule into Claude. It asks for a design, not an
implementation: the output is HTML/CSS mockups to react to, which then get
rebuilt against the real data in this repo.

---

## What I want designed

Two views of the same question — **what time of day do I read?** — on a personal
book log. Both are histograms over the 24 hours of the day. One covers a month;
one covers a single book.

I want a design, not working code: static HTML/CSS mockups with plausible
invented data, so I can see the thing and argue with it. Show each view in at
least three data states (described below), because the sparse cases are the
ones that will break it.

### Feature 1 — the month

The site has a **"Month in reading"** page: a shareable card, a 1080px-wide
artboard showing a calendar grid where each day is a little stack of book
covers, with four summary figures underneath (Books, Pages, Streak, Finished).
It exports to three aspect ratios (9:16, 4:5, 1:1) and there are on-screen
controls — a month stepper, an aspect toggle — that are deliberately *not* part
of the exported card.

Add an hour-by-hour histogram for the month: across these ~30 days, when was I
actually reading? It must be **toggleable** — hidden by default, revealed by a
control, and the page has to look composed in both states rather than leaving a
hole where it was.

**The decision I want you to make and defend:** does the histogram belong
*inside* the exported card, or is it a screen-only panel below it? Inside means
it competes with a calendar grid that already carries the month's shape, and it
has to survive three aspect ratios where the tall one is the only one with room
for figures. Outside means the card stays as it is and the histogram is a
private read rather than a shareable one. Show me the one you'd ship, and a
quick sketch of the other so I can see what I'm giving up.

### Feature 2 — the book

Every book has a detail page. It already has a section called **"When you read
it"** — reading stretches, each drawn as a row of 17px squares, one per day, on
a five-step gold intensity ramp, with gaps between stretches marked by a
labelled rule. Above it is a "Your reading" section: a big progress percentage,
a row of stat blocks, a reading-pace line.

Add the same hour histogram, scoped to this one book, in or beside "When you
read it" — it's the natural home, since that section is already the record of
*when*. Toggleable in the same way, and it should read as the same component as
the month's, not a cousin. A book is often read in a handful of sittings, so
this one is frequently working with very little data.

## The visual language

Dark, warm, printed-object. Paper brown rather than the film log's wine red.

- Background `#1a120a`, panels a shade up at `#1f1609` / `#221809`
- Body text `#f2e6cd`, secondary `#a68f6e`, tertiary `#8a745a`, faintest `#75603f`
- Gold accent `#cfa452`, hover `#ecc87c`, deep `#6b5228`
- Rules and borders `#2b2013`, `#33261a`, `#45341f`
- **Archivo** for UI, labels, numbers; **Newsreader** (serif) for anything that
  reads as prose; `ui-monospace` for small tabular figures
- The existing intensity ramp, which the histogram should probably reuse:
  `#241a10` (empty), then `rgba(207,164,82,0.26)`, `0.48`, `0.74`, then solid
  `#cfa452`

No chart library — this will be built as plain HTML and CSS, so design
accordingly. Inline SVG is fine if it earns it.

## The real data, and its sharp edges

The reading data comes off a Kindle running KOReader, which logs **one row per
page turn**. Each row is: the book, the page number, `started_at` (an exact
timestamp, to the second, of the moment that page was opened), and
`duration_seconds` (how long I stayed on it). A 40-minute sitting is a few
dozen rows, not one.

So the hour data is genuinely there and genuinely precise. What makes it awkward:

1. **Sittings straddle hour boundaries.** A page opened at 23:58 and read for
   six minutes belongs partly to 23:00 and partly to 00:00. Attributing whole
   sessions to their start hour is simpler and slightly wrong; splitting the
   duration across boundaries is right and more work. Say which the design
   assumes.

2. **Midnight is the middle of the reading day, not its edge.** Most of this
   reading happens late at night. A plain 0→23 axis cuts the busiest stretch in
   half and puts the two halves at opposite ends of the chart. Consider an axis
   that starts somewhere like 4am, or some other treatment that keeps a night
   session contiguous — but whatever you do, the reader has to be able to tell
   at a glance that they're not looking at a normal midnight-to-midnight day.

3. **Two possible measures: minutes read, or pages turned.** They tell different
   stories — slow attentive reading versus fast page-flipping. Pick one as the
   default and justify it. If you want a second toggle to switch measures, show
   it, but the show/hide toggle is the required one and shouldn't get lost next
   to it.

4. **The data is sparse and lumpy.** Design for these three states explicitly:
   - **Rich** — a month of daily reading, most hours occupied, a clear evening peak.
   - **Thin** — a book read in four sittings, so four bars and twenty empty
     hours. This must not look broken or embarrassing.
   - **Single** — one sitting, one bar. Does the histogram even appear? If it
     shouldn't below some threshold, say what the threshold is and what shows
     instead.

5. **Timestamps are only as good as the device clock.** A Kindle that's been off
   for a while boots with a stale clock. Nothing in the design has to solve
   this, but don't build anything that implies minute-level precision is
   trustworthy.

6. Everything on the site buckets days in **America/New_York**, and the hours
   must use the same zone or this histogram won't agree with the calendar grid
   sitting next to it.

## Constraints

- **Mobile matters.** The book page is read on a phone as often as a laptop. 24
  bars in a phone-width column is tight — solve it, don't punt to a horizontal
  scroll unless you've argued for it.
- The toggle should feel like the rest of the page's controls (small, quiet,
  gold-on-brown), not like a chart widget bolted on.
- Hover/tap on a bar should tell me something exact. Say what.
- Labels: don't label all 24 hours. Work out the minimum that keeps the axis
  readable.
- Both instances are the same component with different scope. Make the shared
  anatomy obvious, and be explicit about what legitimately differs between them.

## What to hand back

1. A single self-contained HTML file with all the mockups in it, on the real
   palette and fonts, each state labelled.
2. Both placements for the month card (the one you'd ship, larger; the
   alternative, smaller).
3. Book-page version in all three data states, at desktop and phone widths.
4. A short written rationale: the axis decision, the measure decision, the
   card-placement decision, and the sparse-data threshold. A paragraph each,
   not an essay.
