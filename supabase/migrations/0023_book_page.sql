-- Everything the book detail page needs that KOReader cannot tell us.
--
-- /reading answers "how much am I reading". This adds the page that answers
-- "what is this book, and what did I think of it" — the reading tracker's
-- equivalent of the film detail page.
--
-- Three kinds of thing arrive here:
--
--   1. METADATA THE DEVICE DOESN'T HAVE. KOReader scrapes the EPUB, which for a
--      sideloaded file means the filename (see 0022). It has no cover, no
--      publication date, no subjects, no blurb. Those come from Open Library,
--      matched by hand — the titles are too mangled to match automatically —
--      and are stored on `books` alongside the display_* corrections.
--
--   2. THE OWNER'S OPINION. `book_reviews`, one row per *read*: a re-read gets
--      its own review the way a rewatch gets its own diary entry. The row IS
--      the read — its date range is what ties it to a stretch of sessions.
--
--   3. ENDINGS THE PAGE TURNS DON'T IMPLY. A book is normally finished
--      automatically (progress crosses the threshold in reading-view.ts), but
--      nonfiction that is half endnotes never crosses it, and a book you give
--      up on is neither finished nor still in progress. Both are recorded here
--      as facts, never guessed.
--
-- Sync never writes any of it. The upsert in 0020 names its columns explicitly,
-- so nothing added below is reachable from a Kindle.

-- ---------------------------------------------------------------------------
-- books: metadata, and the to-read pile
-- ---------------------------------------------------------------------------

-- A book on the to-read pile has no file yet, so it has no md5 — that is the
-- whole difference between "I intend to read this" and everything else in this
-- table. Postgres lets a unique column hold many nulls, so the constraint that
-- makes sync idempotent still holds for every book that does have a file.
alter table public.books alter column md5 drop not null;

comment on column public.books.md5 is
	'KOReader''s partial-file MD5, or null for a book on the to-read pile that has never been opened. Stable across devices for the same file; changes if you re-download or re-convert the EPUB.';

alter table public.books
	add column if not exists subtitle         text,
	add column if not exists ol_key           text,
	add column if not exists first_published  text,
	add column if not exists kind             text,
	add column if not exists genres           text[]      not null default '{}',
	add column if not exists description      text[]      not null default '{}',
	add column if not exists added_at         timestamptz,
	add column if not exists gave_up_at       timestamptz,
	add column if not exists finished_by_hand boolean     not null default false;

do $$ begin
	alter table public.books
		add constraint books_kind_check check (kind is null or kind in ('Fiction', 'Nonfiction'));
exception when duplicate_object then null; end $$;

comment on column public.books.ol_key is
	'Open Library work key ("/works/OL45804W"), set when the book was matched by hand. Null means unmatched: the page renders sparse and invites a match.';
comment on column public.books.first_published is
	'Display string ("September 1974"), not a date. Open Library''s publication data is too ragged to cast, and this is only ever printed.';
comment on column public.books.description is
	'Blurb, one array element per paragraph. Kept as an array so the page can show the first two and hide the rest without re-splitting prose it did not write.';
comment on column public.books.added_at is
	'When the book was put on the to-read pile. Null means it was never on it — a book can go straight to reading, which is what happens when the Kindle syncs one we have never heard of.';
comment on column public.books.gave_up_at is
	'When reading was abandoned on purpose. Distinct from drift: "set aside" is inferred from thirty quiet days, this is a decision. A session after this timestamp supersedes it, so picking the book back up needs no undo.';
comment on column public.books.finished_by_hand is
	'True when finished_at was set by the owner rather than by crossing the progress threshold. Drives the honest "stopped at page 310 of 604" line — the rest was endnotes.';

-- ---------------------------------------------------------------------------
-- book_reviews: one row per read
-- ---------------------------------------------------------------------------
create table if not exists public.book_reviews (
	id          bigint generated always as identity primary key,
	book_id     bigint not null references public.books (id) on delete cascade,

	-- The read this review is about. Dates rather than a foreign key to some
	-- `reads` table: a read has no existence outside the sessions it covers, and
	-- these two dates are exactly what select them.
	read_from   date   not null,
	read_to     date   not null,

	-- Half stars, 0.5–5. Null is "not rated", which is a real answer and not the
	-- same as unreviewed — see `loved`.
	rating      numeric(2,1),
	loved       boolean not null default false,
	-- This read ended by giving up. Lives on the read, not the book: you can
	-- abandon a book once and finish it years later.
	gave_up     boolean not null default false,
	review_text text,

	pacing      text,
	focus       text,
	moods       text[] not null default '{}',
	tones       text[] not null default '{}',

	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now(),

	constraint book_reviews_range_check  check (read_to >= read_from),
	constraint book_reviews_rating_check check (
		rating is null or (rating >= 0.5 and rating <= 5 and (rating * 2) = trunc(rating * 2))
	),
	constraint book_reviews_pacing_check check (
		pacing is null or pacing in ('Slow', 'Moderate', 'Fast', 'Page-Turner')
	),
	constraint book_reviews_focus_check check (
		focus is null or focus in ('Character-Driven', 'A bit of both', 'Plot-Driven')
	),

	-- Two reviews of the same read is the double-submit, not a use case.
	unique (book_id, read_from)
);

create index if not exists book_reviews_book_idx on public.book_reviews (book_id, read_to desc);

comment on table public.book_reviews is
	'One review per read. A re-read inserts a new row rather than overwriting: the point of keeping both is that the same book is a different book the second time.';
comment on column public.book_reviews.moods is
	'Free multi-select, deliberately uncapped. Vocabulary is enforced in the API rather than a check constraint so the list can grow without a migration.';

-- ---------------------------------------------------------------------------
-- book_highlights
-- ---------------------------------------------------------------------------
-- KOReader keeps highlights in its own table and the sync plugin does not send
-- them yet. This is the shape they will land in; until then the page simply has
-- no highlights section, which is the correct rendering of "none".
create table if not exists public.book_highlights (
	id             bigint generated always as identity primary key,
	book_id        bigint  not null references public.books (id) on delete cascade,
	page           integer not null check (page > 0),
	text           text    not null,
	highlighted_at timestamptz,
	created_at     timestamptz not null default now()
);

-- Re-syncing must not duplicate a passage. Hashed because a highlight can be
-- longer than a btree index will take.
create unique index if not exists book_highlights_unique_idx
	on public.book_highlights (book_id, page, md5(text));
create index if not exists book_highlights_book_idx
	on public.book_highlights (book_id, page);

-- ---------------------------------------------------------------------------
-- Row-level security: same posture as 0020
-- ---------------------------------------------------------------------------
alter table public.book_reviews    enable row level security;
alter table public.book_highlights enable row level security;

-- ---------------------------------------------------------------------------
-- book_days: one row per book per local day
-- ---------------------------------------------------------------------------
-- reading_daily aggregates across the whole shelf; this is the same idea for
-- one book, and it is what the per-book activity strip is drawn from. Distinct
-- pages so re-reading a page twice in a day counts once, matching reading_daily.
create or replace view public.book_days with (security_invoker = true) as
select
	s.book_id,
	(s.started_at at time zone 'America/New_York')::date as day,
	count(distinct s.page)  as pages,
	sum(s.duration_seconds) as seconds
from public.reading_sessions s
group by 1, 2;

comment on view public.book_days is
	'Per-book daily rollup. Timezone must match reading_daily in migration 0020 or a book''s days will not line up with the shelf''s.';

-- ---------------------------------------------------------------------------
-- book_detail: book_progress, but it includes books you have not started
-- ---------------------------------------------------------------------------
-- book_progress INNER JOINs sessions, deliberately: a book with no sessions has
-- not been started and has no business appearing at 0% on the shelf. The detail
-- page has the opposite need — a book on the to-read pile has its own page, and
-- that page is mostly about the fact that there is nothing to report yet.
create or replace view public.book_detail with (security_invoker = true) as
select
	b.id,
	b.md5,
	coalesce(b.display_title, b.title)     as title,
	coalesce(b.display_authors, b.authors) as authors,
	b.title                                as source_title,
	b.subtitle,
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
	'One row per book, started or not. LEFT JOIN — the counts are zero and the timestamps null for a book on the to-read pile.';

revoke all on public.book_days   from anon, authenticated;
revoke all on public.book_detail from anon, authenticated;
