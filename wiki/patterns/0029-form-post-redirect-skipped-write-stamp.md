# 0029 — A form post that redirects skipped the owner's write stamp

**Type:** failure-mode
**Applies when:** an owner edit is a plain `<form method="POST">` that answers with a 303, and the page it lands on shows the old data.

## Symptom
Save, get redirected back, and the page still shows the old values for up to a minute.

## Root cause
`src/middleware.ts` gives the owner's pages `private, max-age=60`, varied on Cookie, and invalidates them by re-stamping the `wv` cookie after an owner write. It only stamped `res.ok` responses under `/api/`. A 303 is not `ok` (and `Response.redirect` headers are immutable), and a page posting to itself (`/activities/[id]`) is not under `/api/`, so neither path changed the Cookie header.

## Fix
Stamp any owner non-GET that succeeds or redirects, copying a redirect (`new Response(res.body, res)`) before appending `set-cookie`. Fixed in PR #257.

## Seen
- 2026-10-11 — activity↔meal links (PR #257); the activity editor already had the bug.
