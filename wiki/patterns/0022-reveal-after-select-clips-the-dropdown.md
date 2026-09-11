# A reveal-after-select composer clips its own autocomplete dropdown

**Type:** failure-mode
**Applies when:** a modal opens showing only a search field and reveals the rest
of the form after a pick (the film/meal composers), and the field's suggestion
dropdown is absolutely positioned under it.

## What happens

`.me__body` (and the film modal's `.modal__body`) is the scroll container:
capped height, `overflow-y: auto`. When the pane holds only the name field, the
body is short, so an absolutely-positioned dropdown extending *below* the field
is clipped to the body's height — you see one row, not the list.

The old meal to-try pane never hit this because it rendered every field at once,
so the body was always tall enough. Adding the reveal gate (name first, rest
after a pick) introduced the clip.

## Fix

Let the body overflow while it's in the pre-select state, then restore the
capped scroll once the form is revealed:

```css
.me__body--picker { overflow: visible; max-height: none; }
```

```js
$('[data-me-pane="log"]').classList.toggle('me__body--picker', !state.locked);
$('[data-me-pane="try"]').classList.toggle('me__body--picker', !state.tryLocked);
```

This is exactly what `EntryEditor.astro`'s film picker already does with
`.modal__panel--picker` — copy that, don't reinvent it.

## Verifying

Real `mousedown`/click on a suggestion row hides the box and reveals the form;
a synthetic `dispatchEvent(new MouseEvent('mousedown'))` in the console does
*not* reliably reproduce the hide, so check the real click path, not JS-dispatch.
