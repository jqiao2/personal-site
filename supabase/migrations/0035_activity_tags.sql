-- Activity tags — the one editable field the activity log had no column for.
--
-- Free text, not a fixed vocabulary like restaurants.to_try_tags: an ingested
-- activity is tagged after the fact ("commute", "z2", "with dad") and the set
-- is whatever the rides turn out to need, so there is nothing to enumerate up
-- front. Same array-plus-gin shape as restaurants.to_try_tags otherwise.
--
-- Deliberately NOT added to the activity_list view: no list or filter reads
-- tags yet, and appending a column there means re-stating the whole view for
-- something nothing queries. Add it when a tag filter exists.
alter table public.activities
	add column if not exists tags text[] not null default '{}';

comment on column public.activities.tags is
	'Free-text tags applied by hand after ingest. Free rather than a fixed vocabulary because the set is whatever the activities turn out to need.';

create index if not exists activities_tags_idx on public.activities using gin (tags);
