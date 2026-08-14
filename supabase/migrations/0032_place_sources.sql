-- A local gazetteer: the places the world knows about, kept here.
--
-- WHY A TABLE RATHER THAN A LOOKUP. Adding a restaurant currently asks
-- Nominatim, live, over the internet, and takes whatever it says. That works
-- and it has three costs: it needs the network at the moment you are typing, it
-- is paced to one request a second by a volunteer service's usage policy, and
-- OpenStreetMap simply does not have half the places this log is made of — a
-- Bangladeshi sweet shop that opened last spring is not in it and may never be.
--
-- So the sources are imported instead of queried. Every row here is a place
-- somebody else has recorded, copied into this database once, and kept: the
-- composer searches locally, instantly, offline, and the answer does not change
-- under it.
--
-- WHICH SOURCES, AND WHY THESE. Only sources whose data may be STORED:
--
--   dohmh       NYC's food-service establishments. Every permitted restaurant,
--               cart and bakery in the five boroughs, with the health
--               department's own geocode. Public data. The best coverage of
--               this city that exists, by a distance.
--   overture    Overture Maps' places theme (CDLA-Permissive 2.0). Global,
--               ~50M POIs, for everywhere that is not New York.
--   foursquare  Foursquare's open Places dataset (Apache 2.0). Global, with the
--               best cuisine taxonomy of the three.
--   osm         OpenStreetMap, via Overpass (ODbL, attribution kept).
--
-- Google Places, Yelp and TripAdvisor are deliberately absent: all three let you
-- keep an id and require the rest to be refreshed rather than stored, which is a
-- subscription to re-fetching, not a database.
--
-- THE ROW IS A CANDIDATE, NEVER A RECORD. Nothing here is shown as fact. A
-- `restaurants` row is what I decided; a `place_sources` row is what somebody
-- else published, offered to me while typing, and copied across only if I pick
-- it. That is why this table is not joined to `restaurants` and has no
-- foreign key to it: they are different kinds of thing, and the moment a
-- suggestion is accepted its values are copied, not referenced. The source that
-- suggested it is remembered on the suggestion, not on the restaurant.

create table if not exists public.place_sources (
	id          bigint generated always as identity primary key,

	-- Which dataset this came from. Text rather than an enum so adding a source
	-- is an import, not a migration.
	source      text        not null check (source in ('dohmh', 'overture', 'foursquare', 'osm')),
	-- That dataset's own identifier: CAMIS, a GERS id, an fsq_place_id, an OSM
	-- type/id. Unique per source, so a re-import updates rather than duplicates.
	source_id   text        not null,

	name        text        not null,
	/**
	 * The name with accents folded, punctuation dropped and case flattened —
	 * what search matches on. Stored rather than computed per query, because it
	 * is the indexed column and 30k of them will not normalise themselves.
	 */
	name_norm   text        not null,

	lat         double precision not null check (lat between -90 and 90),
	lng         double precision not null check (lng between -180 and 180),

	address     text,
	-- Borough in New York, the equivalent elsewhere; renders as the
	-- neighbourhood does on a place.
	locality    text,
	city        text,
	region      text,
	country     text,

	cuisines    text[]      not null default '{}',
	phone       text,
	website     text,

	/** When the import last saw it. Not when the place changed — nobody knows that. */
	imported_at timestamptz not null default now(),

	unique (source, source_id)
);

comment on table public.place_sources is
	'Imported gazetteer of places, from sources whose data may be stored. Candidates for the composer, never records in themselves.';
comment on column public.place_sources.name_norm is
	'Accent-folded, punctuation-stripped, upper-cased name. The column search matches on.';

-- Search is "the words you have typed so far, anywhere in the name", over tens
-- of thousands of rows. Trigrams answer that in one index; a btree cannot,
-- because the query is not a prefix.
create extension if not exists pg_trgm;

create index if not exists place_sources_name_trgm
	on public.place_sources using gin (name_norm gin_trgm_ops);

create index if not exists place_sources_source_idx on public.place_sources (source);
-- Cheap proximity: the composer ranks by distance from the map's centre, and a
-- personal gazetteer is small enough that a box filter on two btrees beats
-- adding PostGIS for it.
create index if not exists place_sources_lat_idx on public.place_sources (lat);
create index if not exists place_sources_lng_idx on public.place_sources (lng);

alter table public.place_sources enable row level security;

-- Readable by anyone, like everything else here; written only by the importer,
-- which uses the service role and bypasses this.
drop policy if exists place_sources_read on public.place_sources;
create policy place_sources_read on public.place_sources for select using (true);

grant select on public.place_sources to anon, authenticated;
