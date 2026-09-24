# `npm run shot` with no Playwright browser and no R2 env

**Type:** failure-mode
**Applies when:** `npm run shot` dies with "Executable doesn't exist … chrome-headless-shell",
or the dev server errors "R2_PUBLIC_URL / R2_ACCOUNT_ID is not set" in a worktree.

## What happened
A fresh `npm install` in a worktree pulls a Playwright whose Chromium was never
downloaded (`%LOCALAPPDATA%\ms-playwright` absent). Separately, the main clone's
`.env` has no R2 keys, and `src/lib/r2.ts` throws at import — so any page that
reaches `restaurants.ts` (the home feed, `/log`, `/month`) 500s locally.

## What works
- **Browser:** skip the download; launch the Edge every Windows box has —
  `chromium.launch({ channel: 'msedge' })` in a scratch script under `tmp/`,
  pointed at the dev server `preview_start` already runs. The in-app browser
  pane's screenshots can come back black when the window isn't drawn.
- **R2:** `R2_PUBLIC_URL` is in `../film-filter-load-optimization-a20ca8/.env`;
  the rest can be dummy values in the worktree's (git-ignored) `.env` — reads never
  touch the S3 client. Restart the dev server after editing `.env`.
- **Supabase paused** (MCP `list_projects` says `INACTIVE`, fetches fail): no
  real data. Check layout with a temporary fixture in the page's frontmatter,
  screenshot, then restore the query line and grep that the fixture is gone.
