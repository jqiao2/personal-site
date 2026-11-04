-- The recipe library at /recipes, owner-only.
--
-- A read-only copy of recipes.json in the private jqiao2/recipes repo, which the
-- daily cron (/api/recipes/sync) upserts by id. Muse writes that repo and has no
-- access to this database. Nothing on the site edits these rows, so a change made
-- here is overwritten by the next sync.
--
-- No indexes beyond the key: the page reads all rows and filters in JS.
create table if not exists public.recipes (
	id              text primary key,
	title           text not null,
	summary         text,
	creator         text,
	added           date not null,
	source_url      text not null,
	site_url        text,
	course          text not null,
	cuisine         text,
	tags            text[] not null default '{}',
	key_ingredients text[] not null default '{}',
	ingredients     text[] not null default '{}',
	steps           text[] not null default '{}',
	note            text,
	prep_minutes    integer,
	cook_minutes    integer,
	servings        text,
	completeness    text not null check (completeness in ('full', 'partial', 'video'))
);

-- RLS on with no policy: the anon key reads nothing. The site reads through the
-- service role, after requireOwner().
alter table public.recipes enable row level security;
