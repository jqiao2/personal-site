-- Persist the credit-graph enrichment so the watched-films network
-- (/projects/film-credit-network) can stay current without an offline rebuild.
--
-- The corpus page derives region / era / prominence at build time in
-- scripts/credit-graph/build.mjs and ships them in a static JSON. The
-- watched-films network needs the same per-person facts, but live: a film logged
-- today should colour and size correctly the next time the page is opened. So the
-- derivation is stored here and updated incrementally whenever a film is cached
-- (src/lib/credit-sync.ts, on the movie-add path), with a full recompute in
-- scripts/credit-graph/build-film-enrichment.mjs.
--
-- All columns are nullable and additive: nothing reads them until it's populated,
-- and the corpus page (which keeps using its static JSON) is unaffected.

-- Per-film era-adjusted percentiles, 0..1, of vote_count and revenue against a
-- +/-2-year window of contemporaries (see build.mjs / credit-derive.mjs). Stored
-- so a person's prominence is a cheap aggregate over their films rather than a
-- corpus-wide recomputation. Null when the film has no release year (reach) or no
-- revenue figure (gross).
alter table public.credit_films
	add column if not exists reach_pct real,
	add column if not exists gross_pct real;

-- Per-person career enrichment. region / era / region_list are bucket indices
-- into the frozen COUNTRIES / ERAS legends in credit-derive.mjs (mirrored to
-- src/data/credit-config.json for the client); reach / hit are the shrunk-mean
-- prominence and typical-hit metrics. enriched_at marks when it was last derived.
alter table public.credit_people
	add column if not exists region      smallint,      -- dominant production-country bucket
	add column if not exists region_list smallint[],    -- every country bucket with 3+ films
	add column if not exists era         smallint,      -- era bucket of their median film year
	add column if not exists reach        real,         -- prominence (era-adjusted, scaled by output)
	add column if not exists hit          real,         -- typical hit size (era-adjusted, per film)
	add column if not exists enriched_at timestamptz;
