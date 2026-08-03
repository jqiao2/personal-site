-- Let a book's displayed title survive the next sync.
--
-- KOReader derives its metadata from the EPUB, which for sideloaded files means
-- the filename. Real values from the live table:
--
--   "Martian_ A Novel, The - Andy Weir"
--   "Power Broker_ Robert Moses and the Fall of New York, The - Robert A. Caro"
--
-- Colons became underscores, the leading article moved to the end, and the
-- author is welded onto the title. Fine as an identifier, unreadable as a
-- heading.
--
-- The problem with just editing `books.title` is that 0020's upsert sets
-- `title = excluded.title` on every sync — deliberately, so a book renamed on
-- the device follows — which would silently undo the edit the next time the
-- Kindle syncs. Cleaning the titles without this migration would look like it
-- worked and then quietly revert.
--
-- So: `title` stays the device's fact, overwritten by sync as before, and these
-- two columns hold the human version. Sync never touches them (they are not in
-- the upsert's column list at all, so there is nothing to get wrong later).
-- Readers take the override when it exists.

alter table public.books
	add column if not exists display_title   text,  -- null = use KOReader's title
	add column if not exists display_authors text;  -- null = use KOReader's authors

comment on column public.books.display_title is
	'Hand-edited title, preferred over the KOReader-derived one. Null means "no correction needed". Never written by the sync endpoint.';
comment on column public.books.display_authors is
	'Hand-edited author list. KOReader writes "N/A" for sideloaded EPUBs, which the ingest normalises to null, so this is usually the only author information there is.';

-- ---------------------------------------------------------------------------
-- book_progress: prefer the corrected values
-- ---------------------------------------------------------------------------
-- Resolving here rather than in the query layer means the page, the API and
-- anything added later all get the corrected title without having to remember
-- to ask for it. The raw value stays reachable as `source_title` — it is what
-- the device calls the file, which is what you need when a book stops matching.
--
-- Dropped rather than replaced: CREATE OR REPLACE VIEW can only append columns,
-- and source_title belongs next to the title it shadows, not bolted on the end.
-- Nothing depends on this view but our own queries.
drop view if exists public.book_progress;

create view public.book_progress with (security_invoker = true) as
select
	b.id,
	b.md5,
	coalesce(b.display_title, b.title)   as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.title                              as source_title,
	b.series,
	b.total_pages,
	b.cover_url,
	b.is_public,
	b.finished_at,
	max(s.page)                             as furthest_page,
	count(distinct s.page)                  as distinct_pages_read,
	sum(s.duration_seconds)                 as seconds_read,
	min(s.started_at)                       as first_read_at,
	max(s.started_at)                       as last_read_at,
	count(distinct (s.started_at at time zone 'America/New_York')::date) as days_read,
	case
		when b.total_pages is null or b.total_pages = 0 then null
		else least(1.0, max(s.page)::numeric / b.total_pages)
	end                                     as progress
from public.books b
join public.reading_sessions s on s.book_id = b.id
group by b.id;

comment on view public.book_progress is
	'Per-book rollup. INNER JOIN by design: a book with zero sessions has not been started and should not appear as 0% progress. `title` is the corrected one; `source_title` is what KOReader calls the file.';

revoke all on public.book_progress from anon, authenticated;
