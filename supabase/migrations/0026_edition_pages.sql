-- How long the book actually is, as distinct from how long the Kindle thinks.
--
-- `total_pages` is KOReader's, and has to stay KOReader's: it is the denominator
-- every progress bar and percentage on the site is measured against, and
-- `furthest_page` is a position in that same pagination. It is not, however, a
-- fact about the book. KOReader repaginates to the font size on the device, so
-- The Power Broker arrives claiming 3,943 pages against a printed edition that
-- Open Library records between 1,246 and 1,312.
--
-- The spines are drawn from page count, so with only that column to go on the
-- shelf shows a book three times wider than it is, and — worse — draws it on a
-- different scale from every book that was typed in rather than synced, whose
-- `total_pages` came from Open Library in the first place. Two scales in one
-- illustration is not a shelf, it is a coincidence.
--
-- So: a second column, for the printed length. Nothing measures against it and
-- nothing computes with it. It exists to be drawn.

alter table public.books
	add column if not exists ol_pages integer
		check (ol_pages is null or ol_pages > 0);

comment on column public.books.ol_pages is
	'The printed edition''s page count, from Open Library. Display only — the spines are drawn from it. Never a denominator: progress is measured in KOReader''s pagination, which is what total_pages holds and what furthest_page indexes into.';

-- ---------------------------------------------------------------------------
-- Carry it through every view a spine is drawn from
-- ---------------------------------------------------------------------------
-- Appended in each case: CREATE OR REPLACE can only add columns at the end, and
-- dropping would take the grants with it.

-- Column-for-column as 0022 left it — CREATE OR REPLACE matches positionally, so
-- restating 0020's shape here renames `source_title` to `series` and Postgres
-- refuses. The corrected titles and the raw one it shadows come from 0022.
create or replace view public.book_progress with (security_invoker = true) as
select
	b.id,
	b.md5,
	coalesce(b.display_title, b.title)     as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.title                                as source_title,
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
	end                                     as progress,
	b.ol_pages
from public.books b
join public.reading_sessions s on s.book_id = b.id
group by b.id;

create or replace view public.book_offline_reads with (security_invoker = true) as
select
	b.id,
	coalesce(b.display_title, b.title)     as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.total_pages,
	b.is_public,
	b.finished_at,
	r.read_from,
	r.read_to,
	r.rating,
	r.loved,
	(select count(*) from public.book_reviews r2 where r2.book_id = b.id) as reads,
	b.ol_pages
from public.books b
left join lateral (
	select r.read_from, r.read_to, r.rating, r.loved
	from public.book_reviews r
	where r.book_id = b.id
	order by r.read_to desc
	limit 1
) r on true
where b.finished_at is not null
  and not exists (select 1 from public.reading_sessions s where s.book_id = b.id);

create or replace view public.book_pile with (security_invoker = true) as
select
	b.id,
	b.md5,
	coalesce(b.display_title, b.title)     as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.subtitle,
	b.series,
	b.total_pages,
	b.cover_url,
	b.ol_key,
	b.first_published,
	b.kind,
	b.is_public,
	b.added_at,
	b.ol_pages
from public.books b
where b.added_at is not null
  and b.started_at is null
  and b.finished_at is null
  and b.gave_up_at is null
  and not exists (select 1 from public.reading_sessions s where s.book_id = b.id);

create or replace view public.book_manual_reads with (security_invoker = true) as
select
	b.id,
	coalesce(b.display_title, b.title)     as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.subtitle,
	b.total_pages,
	b.cover_url,
	b.is_public,
	b.added_at,
	b.started_at,
	b.ol_pages
from public.books b
where b.started_at is not null
  and b.finished_at is null
  and b.gave_up_at is null
  and not exists (select 1 from public.reading_sessions s where s.book_id = b.id);

create or replace view public.book_detail with (security_invoker = true) as
select
	b.id,
	b.md5,
	b.isbn,
	coalesce(b.display_title, b.title)     as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.title                                as source_title,
	b.subtitle,
	b.contributors,
	b.series,
	b.language,
	b.total_pages,
	b.cover_url,
	b.ol_key,
	b.first_published,
	b.kind,
	b.genres,
	b.description,
	b.is_public,
	b.added_at,
	b.finished_at,
	b.finished_by_hand,
	b.gave_up_at,
	coalesce(max(s.page), 0)                as furthest_page,
	count(distinct s.page)                  as distinct_pages_read,
	coalesce(sum(s.duration_seconds), 0)    as seconds_read,
	min(s.started_at)                       as first_read_at,
	max(s.started_at)                       as last_read_at,
	count(distinct (s.started_at at time zone 'America/New_York')::date) as days_read,
	b.started_at,
	b.ol_pages
from public.books b
left join public.reading_sessions s on s.book_id = b.id
group by b.id;

revoke all on public.book_progress      from anon, authenticated;
revoke all on public.book_offline_reads from anon, authenticated;
revoke all on public.book_pile          from anon, authenticated;
revoke all on public.book_manual_reads  from anon, authenticated;
revoke all on public.book_detail        from anon, authenticated;
