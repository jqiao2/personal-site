-- Reading hours: the page turns, bucketed by the hour of the local day.
--
-- Every rollup before this one collapses a session's timestamp to a calendar
-- day and throws the clock away. `reading_sessions` has always held the clock —
-- one row per page turn, `started_at` to the second — so this exposes it for
-- the hour histogram on the month card and the book page.
--
-- A bar counts PAGE TURNS whose own timestamp falls in that hour, `count(*)`
-- rather than `count(distinct page)`. Nothing is split across a boundary: a
-- sitting running 23:40 to 00:20 simply has some of its rows land in 23 and the
-- rest in 00, which is where they happened. Attributing a dwell across the
-- boundary would be more correct and would also mean apportioning a duration
-- that is capped (see below) — precision the underlying number does not have.
--
-- Hours come from the SAME `at time zone 'America/New_York'` expression the day
-- rollups use, so an hour and the day it belongs to can never disagree.

-- ---------------------------------------------------------------------------
-- The sitting gap
-- ---------------------------------------------------------------------------
-- How long a book may sit untouched before picking it up again is a new
-- sitting. A function for the same reason `reading_day_min_pages()` is one:
-- it is a number that will be argued with, so it should be arguable in one
-- place.
--
-- Measured from the END of a page turn (`started_at + duration_seconds`) to the
-- start of the next, not start-to-start, so a long dwell on one page does not
-- fabricate a break behind it. KOReader caps that dwell at 120 seconds, which
-- is well under any threshold worth setting, so the cap cannot invent a sitting
-- either.
create or replace function public.reading_sitting_gap()
returns interval
language sql
immutable
parallel safe
as $$ select interval '30 minutes' $$;

comment on function public.reading_sitting_gap() is
	'Idle time between the end of one page turn and the start of the next, within one book, before the two belong to different sittings. Read-side only.';

-- ---------------------------------------------------------------------------
-- reading_session_hours: one row per page turn, placed in local time
-- ---------------------------------------------------------------------------
-- The base every view below groups. Carries the local day and hour together
-- with a sitting number, so "how many sittings touched 2am" is a count over
-- this and not a second pass at the gap arithmetic.
--
-- The sitting number is a running count of gaps within the book, so it is
-- unique per (book_id, sitting) and means nothing across books. The first row
-- of each book opens sitting 1: `lag` is null there, and null > interval is
-- null, so the coalesce is what makes it a break rather than dropping it.
create or replace view public.reading_session_hours with (security_invoker = true) as
with local as (
	select
		s.book_id,
		s.started_at,
		s.duration_seconds,
		(s.started_at at time zone 'America/New_York')::date                   as day,
		extract(hour from (s.started_at at time zone 'America/New_York'))::int as hour
	from public.reading_sessions s
),
broken as (
	select
		l.*,
		coalesce(
			l.started_at - lag(l.started_at + make_interval(secs => l.duration_seconds))
				over (partition by l.book_id order by l.started_at)
				> public.reading_sitting_gap(),
			true
		)::int as opens_sitting
	from local l
)
select
	book_id,
	day,
	hour,
	sum(opens_sitting) over (
		partition by book_id order by started_at rows unbounded preceding
	) as sitting
from broken;

comment on view public.reading_session_hours is
	'One row per page turn with its local day, local hour, and a per-book sitting number. Sittings are split by reading_sitting_gap() and are only unique within a book.';

-- ---------------------------------------------------------------------------
-- book_hours: a book's lifetime clock
-- ---------------------------------------------------------------------------
-- Deliberately NOT filtered by `reading_day_min_pages()`. The threshold exists
-- for numbers that aggregate across books, where two-page mornings are noise;
-- on one book's own page they are the record of when it was actually open. This
-- matches `book_days_all`, which is what "When you read it" already draws, so
-- the histogram and the day cells beneath it count the same reading.
create or replace view public.book_hours with (security_invoker = true) as
select
	book_id,
	hour,
	count(*)                 as pages,
	count(distinct sitting)  as sittings,
	count(distinct day)      as days
from public.reading_session_hours
group by 1, 2;

comment on view public.book_hours is
	'Per-book page turns by local hour, with how many sittings and days touched each hour. Unfiltered by reading_day_min_pages() -- matches book_days_all, which the book page already draws.';

-- A sitting that spans 1am and 2am is counted by BOTH hours above, which is
-- what the tooltip's "5 of 12 sittings" wants on the left of the "of" and
-- emphatically not what it wants on the right. Hence a separate total: summing
-- the per-hour counts would double-count every sitting that crossed an hour,
-- and this book log's reading crosses hours constantly.
--
-- max() rather than count(distinct): the sitting number is a running sum that
-- starts at 1 and steps by one per break, so its maximum IS the count.
create or replace view public.book_sitting_counts with (security_invoker = true) as
select book_id, max(sitting) as sittings
from public.reading_session_hours
group by 1;

comment on view public.book_sitting_counts is
	'Total sittings per book. The denominator for book_hours.sittings, which counts each hour a sitting touched and so sums to more than this.';

-- ---------------------------------------------------------------------------
-- reading_hours_daily: the month card's clock
-- ---------------------------------------------------------------------------
-- Keyed by day so a month can be sliced out of it, then summed per hour by the
-- caller.
--
-- This one DOES apply the threshold, by joining to `book_days`: the band sits
-- directly under the calendar grid on the same card, and an hour band counting
-- page turns the grid above it refuses to draw would make the card disagree
-- with itself.
create or replace view public.reading_hours_daily with (security_invoker = true) as
select
	h.day,
	h.hour,
	count(*) as pages
from public.reading_session_hours h
join public.book_days d on d.book_id = h.book_id and d.day = h.day
group by 1, 2;

comment on view public.reading_hours_daily is
	'Page turns by local day and hour, counting only book-days that cleared reading_day_min_pages(). Sum over a date range for the month card''s hour band; it counts the same reading as the grid above it.';

-- ---------------------------------------------------------------------------
-- Server-side only, same as everything else in the reading schema
-- ---------------------------------------------------------------------------
revoke all on public.reading_session_hours from anon, authenticated;
revoke all on public.book_hours            from anon, authenticated;
revoke all on public.book_sitting_counts   from anon, authenticated;
revoke all on public.reading_hours_daily   from anon, authenticated;

revoke execute on function public.reading_sitting_gap() from public;
grant  execute on function public.reading_sitting_gap() to service_role;
