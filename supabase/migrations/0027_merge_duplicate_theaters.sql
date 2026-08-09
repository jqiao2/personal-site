-- Reconstructed from the applied migration history. This ran against the live
-- database before it was ever committed, which is why it arrives after the
-- migration numbered above it; the statements below are exactly the ones
-- `supabase_migrations.schema_migrations` recorded for version 0027, so a
-- rebuild from scratch reproduces the database that exists.

-- Collapse theater rows that render as the same venue.
--
-- `theaters` is keyed on (name, city) and the composer shows it as
-- "Name, City" — but parseVenue used to split that label at its LAST comma, and
-- the city half is itself "City, ST". So picking "AMC Empire 25, New York, NY"
-- out of the autocomplete re-split it as name "AMC Empire 25, New York" / city
-- "NY": a distinct pair, a second row, and from then on two identical-looking
-- options in the dropdown (34th St, Lincoln Square and Empire had all forked).
-- The split now happens at the first comma; this merges what the old one made.
--
-- Rows are grouped by their rendered label (case- and whitespace-insensitively),
-- and each group keeps one row, respelled the way the first-comma split reads it.
-- That also repairs a row that was mis-split on its way in and never forked:
-- "Alamo Drafthouse Cinema Brooklyn, Brooklyn" / "NY".

create temporary table theater_merge as
with disp as (
	select id, name, city, name || coalesce(', ' || city, '') as display
	from public.theaters
),
split as (
	select
		id,
		name,
		city,
		display,
		btrim(split_part(display, ',', 1)) as canon_name,
		case
			when strpos(display, ',') > 0
				then nullif(btrim(substr(display, strpos(display, ',') + 1)), '')
		end as canon_city
	from disp
)
select
	id,
	canon_name,
	canon_city,
	-- Keep the row that already agrees with the canonical split (the original,
	-- for a pair the old parse forked); oldest id decides when neither does.
	first_value(id) over (
		partition by lower(regexp_replace(btrim(display), '\s+', ' ', 'g'))
		order by (name = canon_name and city is not distinct from canon_city) desc, id
	) as keeper_id
from split;

-- Point every viewing at the surviving row before its duplicate disappears.
update public.logs l
	set theater_id = m.keeper_id
	from theater_merge m
	where l.theater_id = m.id
		and m.id <> m.keeper_id;

delete from public.theaters t
	using theater_merge m
	where t.id = m.id
		and m.id <> m.keeper_id;

-- Respell the survivors, so what's stored round-trips through the new split.
update public.theaters t
	set name = m.canon_name, city = m.canon_city
	from theater_merge m
	where t.id = m.id
		and m.id = m.keeper_id
		and (t.name, t.city) is distinct from (m.canon_name, m.canon_city);

drop table theater_merge;

-- unique (name, city) doesn't constrain city-less venues at all — Postgres reads
-- two nulls as distinct — so "Metrograph" with no city could pile up. The app
-- looks a venue up before inserting either way; this makes it a rule.
create unique index if not exists theaters_name_no_city_key
	on public.theaters (name)
	where city is null;
