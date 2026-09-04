# A stretched SVG turns every dot into an oval

**Type:** failure-mode
**Applies when:** an inline SVG chart — sparkline, graph, gauge — is drawn in an
abstract viewBox and sized with `width: 100%`.

## What happened

`/activities/athlete` drew each sparkline in a `0 0 100 30` box with
`preserveAspectRatio="none"`, which is the standard trick for making a polyline
fill whatever width the card happens to be. It works for the line. It does not
work for anything else in the box: at a card 200px wide the box scales 2× on x
and 1.5× on y, so every `<circle r="1.4">` renders as an ellipse. On a phone,
where the card is narrow and the anisotropy is largest, the graph read as a row
of blobs.

`vector-effect: non-scaling-stroke` hides this for the *stroke* and so hides the
diagnosis — the line looked fine, which is why the distortion was read as a
styling problem rather than a projection one.

## The fix

Drop `preserveAspectRatio="none"` and let the SVG scale uniformly:

```html
<svg viewBox="0 0 100 26" class="spark__svg"><!-- no preserveAspectRatio --></svg>
```
```css
.spark__svg { width: 100%; height: auto; }   /* not a pinned pixel height */
```

The cost is that the plot now has a fixed aspect ratio instead of filling an
arbitrary box — which is what "the dots are circles" means. Pick the viewBox
height for the shape you want (100 × 26 is a flat, readable sparkline) rather
than pinning `height` in CSS, which reintroduces the stretch from the other
side.

## Also

Points with no room. A daily series (weigh-ins) puts ~50 readings in a 100-unit
box; the dots overlap into a caterpillar no matter how round they are. Past
~20 points drop the dots and let the line carry it — `plot()` in
`src/lib/athlete.ts` does this centrally so both the server render and the
client redraw agree.
