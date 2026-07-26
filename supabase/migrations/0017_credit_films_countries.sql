-- Production countries on the credit-graph film mirror.
--
-- Feeds the "where they work" node colouring on /projects/credit-network: a
-- person is placed by the region most of their films were produced in.
--
-- Stored as the full ISO 3166-1 list in TMDB's order rather than a single
-- resolved country, so a co-production keeps its full provenance and the
-- region mapping can be revised without re-scraping 23k films. The graph
-- builder treats element 0 as the primary production country.

alter table public.credit_films
	add column if not exists countries text[];  -- ISO 3166-1 alpha-2, e.g. {US,GB}

-- Supports slicing the corpus by production country when re-deriving regions.
create index if not exists credit_films_countries_idx
	on public.credit_films using gin (countries);
