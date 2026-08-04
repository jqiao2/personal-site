-- The to-read pile gets a page, and the two ways off it.
--
-- 0023 added `added_at` and left it at that: a book you intend to read was a flag
-- on a row with nothing to list it. This adds what a page needs — a view that
-- says which books are actually on the pile — plus the two transitions the design
-- calls for:
--
--   AUTOMATIC. The Kindle sends a page turn and the book stops being an
--   intention. That already works for a book the device knows: sessions land,
--   `book_pile` stops matching, `book_progress` starts. What did not work is the
--   hand-typed entry — it has no md5, so the sync creates a SECOND row for the
--   same book rather than filling in the one you were waiting on. `merge_book`
--   is the repair, and the page offers it as a suggestion rather than guessing.
--
--   BY HAND. A book started on paper, which the Kindle will never see. Nothing
--   in the schema could say that: sessions are the only evidence of reading, and
--   there are none. `started_at` is the decision, in the same spirit as
--   `gave_up_at` — a fact the reading data cannot imply, recorded rather than
--   inferred.

-- ---------------------------------------------------------------------------
-- books.started_at
-- ---------------------------------------------------------------------------

alter table public.books
	add column if not exists started_at timestamptz;

comment on column public.books.started_at is
	'When reading began away from any device. Only meaningful while the book has no sessions: one page turn from the Kindle supersedes it, the same way a session supersedes gave_up_at. Null is the normal case — a tracked book''s start is min(started_at) over its sessions.';

-- ---------------------------------------------------------------------------
-- book_pile: what is actually on the pile
-- ---------------------------------------------------------------------------
-- Four conditions, and each one is a different way of having left:
--   added_at not null   it was put on the pile at all
--   no sessions         the Kindle has not touched it (the automatic exit)
--   started_at null     it was not started by hand (the manual exit)
--   finished/gave up    neither of those, for a book that skipped the middle
--
-- `added_at` is not cleared on the way out. It records when the book went on the
-- pile, which stays true afterwards; the exits are the other columns' business.
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
	b.added_at
from public.books b
where b.added_at is not null
  and b.started_at is null
  and b.finished_at is null
  and b.gave_up_at is null
  and not exists (select 1 from public.reading_sessions s where s.book_id = b.id);

comment on view public.book_pile is
	'Books intended and not yet opened. Disjoint from book_progress (which requires sessions), from book_manual_reads and from book_offline_reads.';

-- ---------------------------------------------------------------------------
-- book_manual_reads: started, with no page turns behind it
-- ---------------------------------------------------------------------------
-- The shelf's "Currently reading" is built from book_progress, which measures
-- page turns. A book read on paper has none and would never appear there, which
-- is why the pile's "Started it" needs somewhere to send it.
--
-- Deliberately narrow, like book_offline_reads: no progress, no pace, no
-- percentage, because there is no honest value for any of them.
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
	b.started_at
from public.books b
where b.started_at is not null
  and b.finished_at is null
  and b.gave_up_at is null
  and not exists (select 1 from public.reading_sessions s where s.book_id = b.id);

comment on view public.book_manual_reads is
	'In progress off-device. Empties itself: the first synced session moves the book into book_progress, and finishing it moves it into book_offline_reads.';

-- ---------------------------------------------------------------------------
-- merge_book: the hand-typed entry and the synced file were the same book
-- ---------------------------------------------------------------------------
-- Source is the row the Kindle created (it has the md5 and the sessions); target
-- is the row you typed (it has the good title, the cover, the Open Library
-- match). Everything measured moves to the target and the source row goes.
--
-- In SQL because it is five statements that must not half-happen — a target with
-- the sessions but not the md5 would be re-split by the next sync, and a deleted
-- source with its sessions still pointing at it is not a state Postgres will let
-- you leave anyway.
--
-- TITLES. Sync rewrites `title` and `authors` on every push (0020), so the name
-- you typed cannot stay there. It is promoted to display_*, which sync never
-- touches, and the source's KOReader-derived title takes the raw column — which
-- is exactly the split 0022 built those columns for.
create or replace function public.merge_book(p_target bigint, p_source bigint)
returns void
language plpgsql
as $$
declare
	v_md5     text;
	v_title   text;
	v_authors text;
	v_pages   integer;
begin
	if p_target = p_source then
		raise exception 'cannot merge a book into itself';
	end if;

	select md5, title, authors, total_pages
	into v_md5, v_title, v_authors, v_pages
	from public.books where id = p_source
	for update;

	if not found then
		raise exception 'source book % not found', p_source;
	end if;

	-- Sessions carry a unique (book_id, page, started_at). A collision means both
	-- rows hold the same page turn, so the duplicate is dropped rather than
	-- failing the merge — same posture as the sync's ON CONFLICT DO NOTHING.
	update public.reading_sessions s
	set book_id = p_target
	where s.book_id = p_source
	  and not exists (
		select 1 from public.reading_sessions t
		where t.book_id = p_target and t.page = s.page and t.started_at = s.started_at
	  );

	update public.book_highlights h
	set book_id = p_target
	where h.book_id = p_source
	  and not exists (
		select 1 from public.book_highlights t
		where t.book_id = p_target and t.page = h.page and md5(t.text) = md5(h.text)
	  );

	update public.book_reviews r
	set book_id = p_target
	where r.book_id = p_source
	  and not exists (
		select 1 from public.book_reviews t
		where t.book_id = p_target and t.read_from = r.read_from
	  );

	-- Whatever did not move was a duplicate of something the target already had.
	-- The cascade would take these anyway; deleting them explicitly keeps the
	-- statement below from depending on that.
	delete from public.reading_sessions where book_id = p_source;
	delete from public.book_highlights   where book_id = p_source;
	delete from public.book_reviews      where book_id = p_source;

	-- Before the update: md5 is unique, and the source is still holding it.
	delete from public.books where id = p_source;

	update public.books set
		display_title   = coalesce(display_title, title),
		display_authors = coalesce(display_authors, authors),
		title           = coalesce(v_title, title),
		authors         = coalesce(v_authors, authors),
		md5             = coalesce(v_md5, md5),
		-- KOReader's count wins: it is what every page number in the sessions
		-- just moved across is measured against.
		total_pages     = coalesce(v_pages, total_pages),
		-- The book is being read on the device now, so a hand-set start would
		-- only compete with the sessions for the same question.
		started_at      = null,
		updated_at      = now()
	where id = p_target;
end;
$$;

comment on function public.merge_book(bigint, bigint) is
	'Fold the Kindle''s row (source) into the hand-typed one (target) and delete the source. Sessions, highlights and reviews move; duplicates are dropped; the typed title is promoted to display_title so the next sync cannot overwrite it.';

-- ---------------------------------------------------------------------------
-- book_detail: carry started_at
-- ---------------------------------------------------------------------------
-- The book page resolves which shelf a book is on from the row it reads. Without
-- this it would go on calling a book you started on paper "on the to-read pile",
-- which is the one thing the button was pressed to stop it saying.
--
-- Appended rather than slotted in beside added_at: CREATE OR REPLACE can only add
-- columns at the end, and a drop would take the grants with it.
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
	b.started_at
from public.books b
left join public.reading_sessions s on s.book_id = b.id
group by b.id;

-- ---------------------------------------------------------------------------
-- Row-level security: same posture as 0020
-- ---------------------------------------------------------------------------
revoke all on public.book_pile         from anon, authenticated;
revoke all on public.book_manual_reads from anon, authenticated;
revoke all on public.book_detail       from anon, authenticated;
revoke execute on function public.merge_book(bigint, bigint) from anon, authenticated;
