# 0037 — Playwright's next navigation hangs after an HTML5 `dragTo`

**Type:** failure-mode
**Applies when:** checking native drag and drop (`draggable`, `dragstart`/`dragover`/`dragend`) with Playwright, then navigating in the same page.

## Symptom
`locator.dragTo()` drives the drag correctly (order changes, the save fires), but the next
`page.goto()` never reaches `load` or even `domcontentloaded`, and times out at any limit.
The dev server is fine: a plain `fetch` of the same URL answers in ~250 ms.

## Fix
Do the drag checks last, or check the non-drag parts (other routes, sort views) with
`fetch` against the dev server, or in a fresh page/context. Don't extend the timeout:
the wait has no end.

## Seen
- 2026-11-12 — /films/lists/[id] drag-to-reorder; sort views checked via `fetch` instead.
