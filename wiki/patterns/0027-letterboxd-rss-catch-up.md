# 0027 — Catching the film log up from Letterboxd's RSS

**Type:** strategy · **Applies when:** films were logged on Letterboxd but not the site (project paused, site down)

- `letterboxd.com/<user>/rss/` carries the newest ~50 diary entries with TMDB id,
  watched date, rating, rewatch, like and review — but **no tags**. Tags (venue,
  format, `theater`) are scraped from each entry's page.
- Push entries through `logFilm()` (the composer path) rather than writing rows, via
  `scripts/ts-hook.mjs`. That needed `tmdb.ts` to fall back to `process.env` and the
  hook to add the JSON import attribute.
- Not every venue tag is a cinema (`seventh-heaven` is a bar, `central-park` the Nat
  Geo festival). Map tags to honest names in `VENUES`; don't invent a cinema.
- `scripts/backfill-letterboxd-rss.mjs --since=… --dry-run` first; it skips film+date
  pairs already logged.
