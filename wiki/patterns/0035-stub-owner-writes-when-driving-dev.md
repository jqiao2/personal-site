# 0035 — Stub the owner's writes when driving a page in dev

**Type:** strategy
**Applies when:** clicking through an owner page in dev with Playwright to check behaviour, and the page saves as you go (autosave, PUT/POST on every action).

## Symptom
Dev talks to the live Supabase project and `requireOwner()` is true in dev, so a test click on /films/rank PUTs a real, reshuffled ranking over the owner's saved one.

## Fix
Fulfil the write route yourself before navigating, and assert on what would have been sent:

```js
const puts = [];
await page.route('**/api/films/ranking', (r) => {
	puts.push(JSON.parse(r.request().postData()));
	r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
```

Start the server the way `scripts/shot.mjs` does (`dev()` from `astro` on a spare port), drive with the keyboard, read state from the DOM. Reads stay live, so the page shows real data.

## Seen
- 2026-10-20 — /films/rank interleaved placing + list editing (drag, re-rank, undo).
