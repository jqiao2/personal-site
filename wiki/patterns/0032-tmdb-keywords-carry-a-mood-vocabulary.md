# TMDB keywords carry a mood vocabulary; genres and vote count don't carry taste

**Type:** strategy
**Applies when:** placing films on felt axes (tone, energy, mood), refining the
/films/stats taste space, or looking for per-film signal finer than TMDB genres.

## Findings (2026-10-16, measured on the owner's log, 1,077 watched films)
- **Vote count is no taste axis here.** Median film has ~5k TMDB votes (p25 1.7k,
  p90 17k) and `corr(rating, ln(votes))` is −0.03. Release year: −0.01. Both
  spread the cloud without explaining any rating.
- **`/movie/{id}/keywords`** (or `append_to_response=keywords`): median 17
  keywords/film, p10 8, none empty in a 60-film sample. Mostly plot/setting
  microgenres (`neo-noir`, `whodunit`, `space opera`, `coming of age`).
- **TMDB has added mood adjectives as keywords**: `cheerful`, `whimsical`,
  `bittersweet`, `melancholy`, `foreboding`, `dread`, `grim`, `clinical`,
  `tense`, `urgent`, `exhilarated`, `calm`, `reflective`, `introspective`,
  `lyrical`, `wistful`, `chaotic`, `biting`, `witty`… They map straight onto
  valence (light↔dark) × arousal (calm↔intense). Coverage: 53% of films have
  ≥1, 38% have ≥2 — so blend with a genre fallback, don't rely on them alone.
- **Reviews** are too sparse to mine (6–16 per film even for famous titles).

## How to apply
Score each axis as a weighted mean over mood keywords when present, falling back
to the genre tables in `src/lib/film-taste.ts`. For 100% coverage, embed
overview + keyword list and project onto anchor-word directions instead of a
hand table. Fetch keywords once at log/sync time and store them; never at render.

## Outcome (PR: Energy axis)
`movies.keywords` (0073) + `scripts/backfill-movie-keywords.mjs`; genres and
keywords share one weight table per axis (genres capitalised, keywords lower
case, so no collisions). Across the full log 600/1,077 films carry a mood word.
Rating correlates with realism −0.31 and energy −0.23 (vote count was −0.03).
Realism and energy correlate 0.59 — Action/Adventure/Sci-Fi push both up; a
keyword-only realism score would be the next lever if that bothers.
