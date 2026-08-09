-- A book has to earn its place in a day.
--
-- KOReader logs a page turn whenever one happens, so opening a book to check a
-- reference, or reading two pages before falling asleep, lands in the database
-- looking exactly like an evening spent with it. Every day-level number on the
-- site was built on that: the heatmap lit a square for it, the streak survived
-- on it, and the month card printed a whole cover for it.
--
-- So: a minimum. A (book, day) pair counts only when more than
-- `reading_day_min_pages()` pages of that book were turned that day. Below the
-- line the pair is not "a small amount of reading", it is not reading, and it
-- is excluded from the day it belongs to — the heatmap square, the streak, the
-- page and time totals, the month card's cell, and the book's own days-read.
--
-- Two things this deliberately does NOT touch:
--
--   1. `reading_sessions`. The threshold is a read-side interpretation, applied
--      in these views and nowhere else. Every page turn stays on record, so
--      changing the number below reinterprets the whole history rather than
--      losing anything, and there is no ingest path to keep in step.
--   2. A book's progress. `furthest_page`, `distinct_pages_read`, `seconds_read`
--      and the progress bars derived from them still count every page, because
--      they answer "how far into this book am I" — and you did read those pages,
--      whatever the day around them looked like. What the threshold governs is
--      whether a DAY had reading in it, not whether a PAGE was turned.

-- ---------------------------------------------------------------------------
-- The threshold itself
-- ---------------------------------------------------------------------------
-- A function rather than a literal repeated across five views: this is a number
-- that will be argued with, and it should be arguable in one place. Immutable so
-- the planner inlines it and the views underneath stay index-friendly.
create or replace function public.reading_day_min_pages()
returns integer
language sql
immutable
parallel safe
as $$ select 5 $$;

comment on function public.reading_day_min_pages() is
	'Pages of a single book that must be turned in one local day before that book counts towards the day. Strictly greater than: at 5, six pages count and five do not. Read-side only — reading_sessions keeps everything.';

-- ---------------------------------------------------------------------------
-- book_days_all: the rollup before the threshold
-- ---------------------------------------------------------------------------
-- What `book_days` used to be, verbatim, plus the raw event count `reading_daily`
-- reports and a `counts` flag saying which side of the line the row falls on.
-- Splitting it out gives the views below one honest base to filter, instead of
-- copies of the same GROUP BY drifting apart.
--
-- The flag is what the book's own page reads. A minimum is the right rule for
-- every number that aggregates ACROSS books — the grid, the streaks, the month
-- card — because there the small days are noise drowning the signal. On one
-- book's own page they are the opposite: that is the record of when you actually
-- had it open, and a day you know you read on going missing from it would be the
-- page lying about its own subject. So the page draws them, marked, and computes
-- `counts` here rather than comparing page numbers in TypeScript — the threshold
-- has exactly one definition and it is the function above.
create or replace view public.book_days_all with (security_invoker = true) as
select
	s.book_id,
	(s.started_at at time zone 'America/New_York')::date as day,
	count(distinct s.page)  as pages,
	sum(s.duration_seconds) as seconds,
	count(*)                as events,
	count(distinct s.page) > public.reading_day_min_pages() as counts
from public.reading_sessions s
group by 1, 2;

comment on view public.book_days_all is
	'Per-book daily rollup with no minimum applied, `counts` saying whether the row clears it. Read by the book''s own activity strip, which draws every day and marks the ones that do not count. Anything aggregating across books wants book_days instead.';

-- ---------------------------------------------------------------------------
-- book_days: the same rows, minus the ones that do not count
-- ---------------------------------------------------------------------------
-- Same columns and same types as 0023 left it, so everything already selecting
-- from it — the per-book activity strip, the month card, the month picker's
-- counts — picks the threshold up without changing a line.
create or replace view public.book_days with (security_invoker = true) as
select d.book_id, d.day, d.pages, d.seconds
from public.book_days_all d
where d.counts;

comment on view public.book_days is
	'Per-book daily rollup, days under reading_day_min_pages() dropped. Timezone must match reading_daily or a book''s days will not line up with the shelf''s. Use book_days_all for the unfiltered rows.';

-- ---------------------------------------------------------------------------
-- reading_daily: built from the book-days that count
-- ---------------------------------------------------------------------------
-- It used to aggregate sessions directly, which had no notion of which book a
-- page belonged to and so could not apply a per-book minimum. Summing the
-- qualifying book-days instead gives the same numbers wherever every book
-- cleared the line, and drops the rest — including the day itself, when nothing
-- on it qualified. A day with three books at two pages each is not a reading day
-- and no longer appears here, which is what carries the threshold into
-- reading_heatmap() and the streaks in reading_stats().
--
-- `pages_read` is unchanged in meaning: distinct pages per book, summed, which is
-- what count(distinct (book_id, page)) came to. The casts are load-bearing —
-- sum() over bigint returns numeric, and CREATE OR REPLACE cannot change a
-- column's type.
create or replace view public.reading_daily with (security_invoker = true) as
select
	d.day,
	sum(d.pages)::bigint   as pages_read,
	sum(d.seconds)::bigint as seconds_read,
	count(*)::bigint       as books_touched,
	sum(d.events)::bigint  as raw_events
from public.book_days_all d
where d.counts
group by 1;

comment on view public.reading_daily is
	'One row per local calendar day, counting only books that cleared reading_day_min_pages() that day. Feeds the heatmap and the streaks. Days with no qualifying reading are absent, not zero -- use reading_heatmap() for the full date spine.';

-- ---------------------------------------------------------------------------
-- book_progress / book_detail: days_read follows the same rule
-- ---------------------------------------------------------------------------
-- Both counted every local date with a session on it, which after the above
-- would have a book's shelf card claiming fourteen days beside an activity strip
-- drawing eleven. One definition of a day read, or neither is worth printing.
--
-- Restated in full because CREATE OR REPLACE takes the whole definition; the
-- only edit to each is the `days_read` expression, plus `last_counted_day`
-- appended to book_detail. Column-for-column as 0026 left them — replacement
-- matches positionally, so the order here is not cosmetic.

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
	(select count(*) from public.book_days d where d.book_id = b.id) as days_read,
	case
		when b.total_pages is null or b.total_pages = 0 then null
		else least(1.0, max(s.page)::numeric / b.total_pages)
	end                                     as progress,
	b.ol_pages
from public.books b
join public.reading_sessions s on s.book_id = b.id
group by b.id;

-- `last_counted_day` is the last day this book holds a cell on, which is no
-- longer the same as the day of `last_read_at`: a book finished on a two-page
-- morning has a final session and no final cell. The month card dates an
-- inferred finish from this, so the seal lands on a square that exists.
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
	(select count(*) from public.book_days d where d.book_id = b.id) as days_read,
	b.started_at,
	b.ol_pages,
	(select max(d.day) from public.book_days d where d.book_id = b.id) as last_counted_day
from public.books b
left join public.reading_sessions s on s.book_id = b.id
group by b.id;

comment on view public.book_detail is
	'One row per book, started or not. LEFT JOIN — the counts are zero and the timestamps null for a book on the to-read pile, and for a book read off-device. days_read and last_counted_day apply reading_day_min_pages(); the page and time totals beside them do not.';

-- ---------------------------------------------------------------------------
-- Same posture as everything else here: server-side only
-- ---------------------------------------------------------------------------
-- The views are security_invoker over tables anon cannot read, and the revokes
-- are the belt to that pair of braces. The function is revoked from PUBLIC
-- rather than from anon and authenticated — see 0021 for why that distinction
-- is the whole point.
revoke all on public.book_days_all from anon, authenticated;
revoke all on public.book_days     from anon, authenticated;
revoke all on public.reading_daily from anon, authenticated;
revoke all on public.book_progress from anon, authenticated;
revoke all on public.book_detail   from anon, authenticated;

revoke execute on function public.reading_day_min_pages() from public;
grant  execute on function public.reading_day_min_pages() to service_role;
