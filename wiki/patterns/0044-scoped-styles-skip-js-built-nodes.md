# Scoped styles skip elements a client script builds

**Type:** failure-mode
**Applies when:** a `<script>` creates elements with `document.createElement`
(search results, autocomplete rows, toasts) and the component's `<style>` targets them.

## What happens

Astro scopes a component's CSS by adding its `astro-xxxx` class to every element
in the template and compiling `.a b` to `.a:where(.astro-xxxx) b:where(.astro-xxxx)`.
Nodes built at runtime never get that class, so every rule aimed at them silently
matches nothing. The list page's "Add a film" search showed browser-default
buttons (light gray, rounded) and posters at their native 92px width, while the
`<ul>` around them, which is in the template, was styled fine.

## Fix

Wrap the runtime part of the selector in `:global()` and keep the template
ancestor scoped, so the rule still can't leak out of the component:

```css
.add__results :global(button) { … }
.add__results :global(img) { … }
```

`WatchlistComposer.astro` already did this (`.results :global(li)`). Check the
compiled CSS with `@astrojs/compiler`'s `transform()` if unsure which half got scoped.
