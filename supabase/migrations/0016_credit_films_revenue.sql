-- Worldwide gross on the credit-graph film mirror.
--
-- Feeds the "typical hit size" node metric on /projects/credit-network. That
-- metric never compares raw dollars: TMDB reports revenue in nominal terms for
-- only ~54% of the corpus, and the coverage itself is era-skewed (28% of 1920s
-- films against 65% of 1980s ones). Ranked raw, it would collapse into "worked
-- recently". The graph builder instead scores each film against a ±2-year
-- window of its contemporaries, so this column stores the plain figure and the
-- normalisation lives in scripts/credit-graph/build.mjs.
--
-- 0 rather than null when TMDB has no figure, matching what the API returns;
-- the builder treats 0 as "unknown" and excludes it from the comparison.

alter table public.credit_films
	add column if not exists revenue bigint not null default 0;  -- worldwide gross, nominal USD

-- Lets the builder pull just the films that carry a figure when re-deriving the
-- per-era percentile windows.
create index if not exists credit_films_revenue_idx
	on public.credit_films (revenue)
	where revenue > 0;
