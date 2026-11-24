# Vercel bot protection blocks device syncs silently

**Type:** failure-mode · **Applies when:** a Kindle, Shortcut or board sync goes quiet, an endpoint answers 429, or adding a machine-to-machine endpoint

## What happened

- Firewall `bot_protection` was set to `challenge` on 2026-09-13. The Kindle and
  Apple Health pushes cannot run the JavaScript challenge, so they got a 429
  before any function ran. Nothing appeared in runtime logs, and the KOReader
  plugin hides background failures. It went unnoticed until 2026-11-24.
- Vercel's own crons (Strava, recipes) were unaffected, so "Strava syncs" does
  not clear the firewall.

## Check

- `curl -i` the endpoint: `X-Vercel-Mitigated: challenge` is the firewall, a JSON
  401 is the app.
- The Vercel MCP 404s on firewall data here. The CLI works:
  `vercel api "/v1/security/firewall/config/active?projectId=…&teamId=…"`. Replace
  `active` with a version number for the dated change.

## Fix in place

Firewall rule "Device sync endpoints" (dashboard state, not in the repo): bypass
for exactly `/api/books/sync`, `/api/activities/weight` and
`/api/flight-poster/sync`, each only with an `Authorization: Bearer ` header. The
rule may be case-sensitive, so send `Bearer` exactly. A
made-up token still reaches the function and gets a 401, before any body read or
database call. A new device endpoint needs its own entry.
