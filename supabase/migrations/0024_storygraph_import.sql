-- Room for the books that were read before the Kindle was.
--
-- 0020 built the reading tracker around KOReader: a book is a file with an md5,
-- and everything known about it is derived from page turns. 0023 loosened that
-- once, for the to-read pile — a book you intend to read has no file yet.
--
-- This loosens it a second time, for the opposite end. A StoryGraph export
-- covers years of reading on paper: books that were finished, rated and reviewed
-- and that will never have a single page_stat row. They are not "unstarted" and
-- they are not "in progress"; they are finished, and the only evidence is the
-- date range you typed into another service.
--
-- Nothing here is new machinery — `finished_at`, `added_at` and `book_reviews`
-- already say all of that. What was missing was two columns of provenance and a
-- view that admits they exist.

-- ---------------------------------------------------------------------------
-- books: identifiers the device never had
-- ---------------------------------------------------------------------------

alter table public.books
	add column if not exists isbn         text,
	add column if not exists contributors text[] not null default '{}';

comment on column public.books.isbn is
	'ISBN-13 or ISBN-10 as the source recorded it, digits only. Not unique: two editions of the same book are the same row here, and the imported value is whichever edition was logged. Its job is to be a search key for Open Library, which is the one thing the mangled titles are useless for.';
comment on column public.books.contributors is
	'Translators, narrators, illustrators — "Ken Liu (Translator)", role included, one element each. Kept apart from `authors` because a byline is not a credits list: The Three-Body Problem is by Cixin Liu, and the fact that Ken Liu is the reason you could read it belongs further down the page.';

-- ---------------------------------------------------------------------------
-- book_detail: carry the two new columns
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE can only append columns to a view, and these belong beside
-- the identifiers they extend rather than bolted on the end. Nothing depends on
-- this view but our own queries (see 0023).
drop view if exists public.book_detail;

create view public.book_detail with (security_invoker = true) as
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
	count(distinct (s.started_at at time zone 'America/New_York')::date) as days_read
from public.books b
left join public.reading_sessions s on s.book_id = b.id
group by b.id;

comment on view public.book_detail is
	'One row per book, started or not. LEFT JOIN — the counts are zero and the timestamps null for a book on the to-read pile, and for a book read off-device.';

-- ---------------------------------------------------------------------------
-- book_shelf: finished books the page turns cannot account for
-- ---------------------------------------------------------------------------
-- `book_progress` INNER JOINs sessions and should keep doing so: it is what the
-- progress bars, the pace and the spine fills are measured from, and a book with
-- no sessions has no honest value for any of them.
--
-- But the Finished shelf is not a progress readout, it is a list of books you
-- have read, and leaving twenty of them off it because the reading predates the
-- device makes the shelf a fact about the Kindle rather than about the reading.
--
-- So: a second, deliberately narrow view. Finished, no sessions at all, with the
-- read's own dates and rating pulled off the review — which for these books is
-- the only record of when it happened. The shelf renders them without pages,
-- percentages or times, because there are none and inventing them would make the
-- honest rows next to them unreadable.
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
	-- A re-read has two review rows; the shelf shows the book once, dated by the
	-- most recent read, and says how many there were.
	(select count(*) from public.book_reviews r2 where r2.book_id = b.id) as reads
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

comment on view public.book_offline_reads is
	'Finished books with no page-turn data — read on paper, or before the Kindle. Complement of book_progress''s finished rows: between them every finished book appears exactly once.';

revoke all on public.book_detail        from anon, authenticated;
revoke all on public.book_offline_reads from anon, authenticated;
