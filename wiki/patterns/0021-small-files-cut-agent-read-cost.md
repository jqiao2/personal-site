# Keep files small to cut agent read-cost (ts / js / astro / html)

**Type:** strategy
**Applies when:** editing or reasoning about any oversized source file — a lib
module, a page, a client script — and deciding whether to split it.

## The real reason to split here

Not encapsulation. **Token cost.** An agent has no eyes and no partial
understanding: to change one function in `src/lib/films.ts` it tends to read the
file, and that file is 2860 lines. Every oversized file an agent opens burns
context it then can't spend on the actual task, and a god-module gets opened by
almost every task in its feature. The metric to minimise is *how many lines an
agent must read to safely make a typical change*.

Scoped-CSS encapsulation (wiki 0020) is a real constraint for `.astro`, but it's
downstream of this: we split for read-cost, and 0020 is how to do it in Astro
without breaking styling.

## What actually lowers read-cost

1. **Hoist stable, widely-imported types/constants into their own small module.**
   The biggest single win. A page that needs `ActivityRow` should be able to read
   a ~300-line `activities.types.ts`, not the 1400-line query module. Types change
   rarely and are imported everywhere, so a targeted read of them is cheap and
   frequent. Convention: `feature.types.ts` next to `feature.ts`.

2. **Break a god-module into cohesive feature slices.** `films.ts` (58 exports)
   and `activities.ts` are data-access modules that bundle types + many query
   functions + unrelated extras (e.g. films.ts carries the credit-collaboration
   network at the bottom). Split by what a task reads together: e.g.
   `activities.types.ts`, `activities-queries.ts` (list/get/month), `activities-stats.ts`.
   A task touching stats then reads one small file.

3. **Prefer direct imports over a barrel `index.ts`.** A barrel re-exporting the
   whole feature *reinstates* the bloat: following the import still lands in the
   big graph, and reading the barrel teaches nothing about where code lives.
   Barrels are fine ONLY for a types/constants module where the import path
   ergonomics matter; never for feature/implementation modules here. (This also
   avoids the bundle-size and circular-dep costs barrels are known for.)

4. **Don't over-fragment.** One-function-per-file (the extreme some guides push)
   trades read-cost for *discovery* cost: the agent now has to find which of forty
   files holds the thing. The optimum is cohesive medium-small modules (roughly
   ≤400–500 lines), each named for the slice it owns, not maximal shredding.

## By file type

- **`.ts` / `.js` lib modules:** apply 1–4 above. For a plain client `.js` like
  `src/scripts/credit-network.js` (1127 lines), split into ES modules by concern
  and `import` them from the entry script — same cohesion rules, no framework
  involved.
- **`.astro` pages/components:** push frontmatter logic into `src/lib`
  (see [[push-frontmatter-logic-to-lib]]), move template regions into
  sub-components, and only then worry about styles — which is where 0020's
  scoped-vs-global rule applies. Biggest current offenders: `books/[id].astro`
  (2411), `films/watched.astro` (2128).
- **`.html`:** the only shippable HTML here is `src/pages/archive/**` (frozen,
  off-limits — do not touch) and the `design/*.dc.html` mocks (not shipped).
  There is effectively no live HTML to split; if HTML shows up, it becomes an
  Astro component, not a hand-split file.

## Sanity check when you split

The split is only a win if a *typical* change now reads less. If moving code out
means the next task has to read both the new file AND the old one to understand
the flow, the boundary was wrong — cut along how tasks actually read, not along
tidy taxonomy. Verify behaviour is unchanged (build/screenshot), since a
read-cost refactor should be behaviour-neutral.

## STANDING TASK — split these when you touch them

This is a live checklist, not a suggestion. **When a task edits one of the files
below, split it as part of that same change** (apply the tactics above), then
strike it off this list in the same PR. Do it opportunistically — a task that
only reads the file leaves it alone; a task that meaningfully edits it pays the
split-tax while it's already in there. Keep changes behaviour-neutral and verify
with a build/screenshot. When a new file crosses ~800 lines, add it here.

Highest leverage first (line counts as of origin/main, Sep 2026):

- [ ] `src/lib/films.ts` — 2860 / 58 exports. Types → `films.types.ts`; peel the
  credit-network section (~2592+) into `films-credits.ts`.
- [ ] `src/lib/activities.ts` — 1400. Types → `activities.types.ts`; consider
  `-queries` / `-stats` slices.
- [ ] `src/pages/books/[id].astro` — 2411. Frontmatter→lib, template→sub-components (0020).
- [ ] `src/pages/films/watched.astro` — 2128. Same treatment.
- [ ] `src/components/EntryEditor.astro` — 1864, and `src/components/MealEditor.astro`
  — 1811 (already partly split, #230/#231; the wiring `<script>` is the remaining bulk).
- [ ] `src/pages/activities/all.astro` — 1740, `src/pages/activities/[id].astro` — 1596.
- [ ] `src/pages/films/watchlist.astro` — 1591, `src/pages/films/movie/[tmdbId].astro` — 1352.
- [ ] `src/components/PlaceEditor.astro` — 1235.
- [ ] `src/lib/restaurants.ts` — 1148, `src/scripts/credit-network.js` — 1127.
