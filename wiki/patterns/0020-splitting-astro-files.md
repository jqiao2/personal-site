# Splitting oversized `.astro` files (and why you don't just extract the CSS)

**Type:** strategy
**Applies when:** an `.astro` file has grown large (roughly >500 lines, or two
files carry a near-duplicate block), and you're editing it anyway — decide then
whether to split it.

**Why split at all:** to cut agent read-cost, not for encapsulation — see
[[0021-small-files-cut-agent-read-cost]] for the governing rationale. This
pattern is the Astro-specific *how*: doing it without breaking scoped styling.

## The instinct, and the correction

The natural move — "pull the `<style>` out into a `.css` file so the component
is just markup" — **does not work in Astro the way it does in React.** Astro
scopes a `<style>` block by stamping a `data-astro-cid-*` attribute onto the
elements in that component's template. The moment you move those rules out:

- **`import './thing.css'`** → the CSS becomes **global** and is emitted even if
  the component never renders. It "leaks."
- **`<style is:global>`** → global by definition.
- **`<style>` can't `@import` or reference an external file** and keep scoping.
  Scoping only covers rules written literally inside the tag.

So extracting CSS by file-type *removes the encapsulation that made the big file
safe to change*. That's the opposite of detangling. (Confirmed against the Astro
styling guide, Sep 2026.)

## What to do instead — in priority order

1. **Split by UI region into sub-components, not by file-type.** The Astro-native
   way to shrink a 2000-line component is to carve it into smaller `.astro`
   components, each co-locating *its* markup + *its* scoped `<style>` + the sliver
   of `<script>` it owns. `StarPicker.astro` is the template: small, self-styled,
   reused. This is the main lever. It keeps styles scoped *and* shrinks the file.

2. **Extract shared, skinnable UI as one component parameterised by CSS custom
   properties + slots/props** — never by copying a stylesheet between two files.
   `StarPicker` already does this: hosts pass `--sp-empty` / `--sp-fill` / `--sp-size`
   and get the same widget in their own palette. The rating row (five stars + two
   toggles) is shared by the film composer (`EntryEditor.astro`) and the restaurant
   composer (`MealEditor.astro`) with different skins and label text — the exact
   shape for this: one component, palette via custom properties, text via props/slots.

3. **Move pure logic out of `<script>`/frontmatter into `src/lib`.** This *is* a
   real detangle that keeps working, because logic has no scoping to lose. Pure,
   testable functions (e.g. MealEditor's photo decode/resize/encode, the geocoder
   glue) belong in `src/lib/*.ts`; only the DOM wiring stays in the component.
   Matches the standing "push frontmatter logic to lib" habit.

4. **Reserve external/global CSS for tokens, resets and utilities only** — the
   palette variables (`--marigold`, `--ink`, …), a reset, layout utilities.
   Shared *look* = shared custom properties, not a shared class stylesheet.

## When NOT to split

Opportunistic, not a big-bang refactor. Split the file you're already in, in a
diff that stays reviewable. A one-off block used in a single place stays inline —
YAGNI. The `me__`-prefixed `<style is:global>` at the bottom of `MealEditor.astro`
is a *legitimate* global exception (it styles nodes built in JS at runtime, which
never get the scoped attribute); don't "fix" it by scoping.

## Going-forward rule

When editing an `.astro` file: if it's oversized or you're touching a block that
is duplicated in a sibling, (a) extract shared/skinnable UI as a
custom-property-themed component, (b) split large files into region
sub-components with their own scoped styles, (c) move pure logic to `src/lib`.
Leave scoped CSS co-located with the markup it styles.
