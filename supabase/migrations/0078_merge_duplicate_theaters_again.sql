-- Collapse the theater duplicates that piled up again after 0027.
--
-- 0027 merged the forks and said parseVenue now split "Name, City, ST" at the
-- first comma — but that code change never shipped. parseVenue kept splitting at
-- the LAST comma, so every pick of "AMC Empire 25, New York, NY" from the
-- autocomplete became name "AMC Empire 25, New York" / city "NY", a fresh row.
-- The split is fixed in films.ts now, resolveTheaterId matches on the rendered
-- label before inserting, and the index below makes a label collision a rule
-- rather than a hope.
--
-- Rows are grouped by coordinates (0074/0075 gave every spelling of a venue the
-- same point, and no two venues share one), which also catches the hand-typed
-- variants a label match can't: "BAM Rose" / "BAM Rose, New York" /
-- "BAM Rose, Brooklyn, NY", "Metrograph, NYC" / "Metrograph, New York, NY".
-- The most-viewed row survives (oldest id on a tie).

create temporary table theater_merge as
select
	id,
	first_value(id) over (
		partition by lat, lng
		order by (select count(*) from public.logs l where l.theater_id = t.id) desc, id
	) as keeper_id
from public.theaters t
where lat is not null;

update public.logs l
	set theater_id = m.keeper_id
	from theater_merge m
	where l.theater_id = m.id
		and m.id <> m.keeper_id;

delete from public.theaters t
	using theater_merge m
	where t.id = m.id
		and m.id <> m.keeper_id;

drop table theater_merge;

-- Respell every row the way the first-comma split reads its label, so what's
-- stored round-trips through parseVenue.
update public.theaters t
	set name = c.name, city = c.city
	from (
		select
			id,
			btrim(split_part(label, ',', 1)) as name,
			case when strpos(label, ',') > 0
				then nullif(btrim(substr(label, strpos(label, ',') + 1)), '')
			end as city
		from (select id, name || coalesce(', ' || city, '') as label from public.theaters) s
	) c
	where t.id = c.id
		and (t.name, t.city) is distinct from (c.name, c.city);

-- Two rows that render as the same "Name, City" option can no longer exist,
-- whichever comma they were split at.
create unique index if not exists theaters_label_key
	on public.theaters (lower(regexp_replace(btrim(name || coalesce(', ' || city, '')), '\s+', ' ', 'g')));
