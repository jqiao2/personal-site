# 0002 — `localDay()` in Astro frontmatter is UTC, not the user's day

**Type:** failure-mode
**Applies when:** defaulting a date field (composer, form, filter) to "today".

## What went wrong

`MealEditor.astro` computed its date default in the component frontmatter:

```astro
---
import { localDay } from '../lib/day';
const config = { fallbackDate: localDay() };   // runs on the SERVER
---
```

The comment beside it said "today is the browser's day rather than the
server's". It wasn't. Astro frontmatter runs on the server, so `localDay()` read
the Vercel function's clock — UTC — and the composer opened on tomorrow's date
from 8pm Eastern onwards, which is exactly when someone logs dinner.

`src/lib/day.ts` documents this ("Browser only: on the server the runtime's zone
is UTC, i.e. nobody's"). The import site is where it gets forgotten.

## Rule

`localDay()` is only correct inside a `<script>` block. If a default date has to
cross the frontmatter/script boundary it stops being the user's day. Either call
it in the client script, or, when there is genuinely no browser, use `siteDay()`
and accept that it's the owner's zone rather than the visitor's.

Same trap for any `new Date()` in frontmatter that ends up serialized into a
config JSON tag.

## Also

The composer used to inherit the previous visit's date when logging another meal
at a place already in the log. Inheriting a rating or a verdict is a guess worth
making; inheriting a DATE silently backdates the entry to the last visit. Carry
judgments, never timestamps.
