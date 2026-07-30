-- Lower the per-role graph thresholds to match the widened film corpus.
--
-- The corpus behind the credit network moved from TMDB's vote_count >= 100
-- (~23k films) to >= 50 (~36k films). Held at the old 10/5/3 floors that alone
-- grew the graph from 7.5k to 11.9k people; the floors below take it to ~25.2k,
-- which is the size the /projects/credit-network page is now tuned for.
--
-- These are the numbers migration 0015 seeded, restated as an update because
-- that insert is `on conflict do nothing` and so cannot revise an applied DB.
-- build.mjs reads its thresholds from this table when run with --from=db, so
-- these values and the defaults in scripts/credit-graph/build.mjs must agree.

update public.credit_roles set min_films = 5 where role = 'actor';
update public.credit_roles set min_films = 2 where role = 'director';
update public.credit_roles set min_films = 2 where role = 'composer';
