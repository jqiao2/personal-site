-- Reading tracker: KOReader -> Postgres.
--
-- Sibling to the film log: that models the owner's relationship to a MOVIE, this
-- models the owner's relationship to a BOOK. The difference is where the data
-- comes from — films are typed in by hand, books arrive automatically from
-- KOReader's Statistics plugin, which logs every page turn with a timestamp and
-- a dwell duration. Nothing here is ever entered manually.
--
-- KOReader's own tables, which this mirrors so the sync plugin can push rows
-- through with minimal translation:
--
--   book            (id, title, authors, notes, last_open, highlights, pages,
--                    series, language, md5, total_read_time, total_read_pages)
--   page_stat_data  (id_book, page, start_time, duration, total_pages,
--                    UNIQUE (id_book, page, start_time))
--
-- IMPORTANT: KOReader's book.id is a local autoincrement, so it differs on every
-- device. md5 (a partial hash of the file) is the only stable cross-device
-- identifier. We key on md5 and discard their integer ids at the boundary.
--
-- Run with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- books
-- ---------------------------------------------------------------------------
create table if not exists public.books (
	id           bigint generated always as identity primary key,
	md5          text        not null unique,
	title        text        not null,
	authors      text,
	series       text,
	language     text,
	total_pages  integer     check (total_pages is null or total_pages > 0),

	-- The owner's metadata, not KOReader's. Nullable by design: absent values
	-- should render as clean omissions, not empty states.
	cover_url    text,
	is_public    boolean     not null default true,
	finished_at  timestamptz,

	created_at   timestamptz not null default now(),
	updated_at   timestamptz not null default now()
);

comment on column public.books.md5 is
	'KOReader''s partial-file MD5. Stable across devices for the same file; changes if you re-download or re-convert the EPUB.';
comment on column public.books.is_public is
	'Gate for the public /reading page. Lets you keep a book private without losing its sessions.';

-- ---------------------------------------------------------------------------
-- reading_sessions
-- ---------------------------------------------------------------------------
-- One row per (page, moment you landed on it). KOReader emits these as you turn
-- pages, so a 40-minute sitting produces many rows, not one.
create table if not exists public.reading_sessions (
	id               bigint      generated always as identity primary key,
	book_id          bigint      not null references public.books (id) on delete cascade,
	page             integer     not null check (page > 0),
	started_at       timestamptz not null,
	duration_seconds integer     not null check (duration_seconds >= 0),

	-- Snapshot of the book's page count at the time of reading. KOReader
	-- repaginates when you change font size, so this drifts between sessions;
	-- keeping it per-row lets us normalise later if we ever care.
	total_pages      integer,

	device           text        not null default 'unknown',
	created_at       timestamptz not null default now(),

	-- The constraint that makes re-syncing safe. The plugin resends overlapping
	-- ranges after any failed or partial sync; without this every retry silently
	-- double-counts the overlap. All inserts are ON CONFLICT DO NOTHING.
	unique (book_id, page, started_at)
);

create index if not exists reading_sessions_started_at_idx
	on public.reading_sessions (started_at desc);
create index if not exists reading_sessions_book_started_idx
	on public.reading_sessions (book_id, started_at desc);
create index if not exists reading_sessions_device_started_idx
	on public.reading_sessions (device, started_at desc);

-- ---------------------------------------------------------------------------
-- reading_sync_batches  (operational, not analytical)
-- ---------------------------------------------------------------------------
-- Cheap insurance. When the Kindle claims it synced and nothing shows up, this
-- says whether the request ever arrived.
create table if not exists public.reading_sync_batches (
	id                bigint      generated always as identity primary key,
	device            text        not null,
	books_received    integer     not null default 0,
	sessions_received integer     not null default 0,
	sessions_inserted integer     not null default 0,
	received_at       timestamptz not null default now()
);

create index if not exists reading_sync_batches_received_idx
	on public.reading_sync_batches (received_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Unlike the film tables, these are NOT publicly readable. Session-level rows
-- are a precise log of when the owner is awake at night; the public /reading
-- page serves aggregates, computed server-side. RLS is enabled with no policies
-- at all, so anon and authenticated see nothing through PostgREST; the API
-- routes read and write with the service-role key, which bypasses RLS.
alter table public.books                enable row level security;
alter table public.reading_sessions     enable row level security;
alter table public.reading_sync_batches enable row level security;

-- ---------------------------------------------------------------------------
-- Aggregate views
-- ---------------------------------------------------------------------------
-- TIMEZONE: day boundaries are the whole point of a reading streak, and "pages
-- read today" bucketed in UTC cuts late-night sessions in half. Change the zone
-- here and every view (and reading_stats below) follows.
--
-- security_invoker so the views inherit the RLS above instead of running with
-- the definer's rights — otherwise a view over a locked-down table hands anon a
-- way around it. Belt and braces: the grants are revoked below too.

create or replace view public.reading_daily with (security_invoker = true) as
select
	(s.started_at at time zone 'America/New_York')::date as day,
	-- Distinct (book, page) so re-reading the same page twice in one day counts
	-- once. That is what a human means by "pages read".
	count(distinct (s.book_id, s.page))                  as pages_read,
	sum(s.duration_seconds)                              as seconds_read,
	count(distinct s.book_id)                            as books_touched,
	count(*)                                             as raw_events
from public.reading_sessions s
group by 1;

comment on view public.reading_daily is
	'One row per local calendar day. Feeds the heatmap. Days with no reading are absent, not zero -- use reading_heatmap() for the full date spine.';

create or replace view public.book_progress with (security_invoker = true) as
select
	b.id,
	b.md5,
	b.title,
	b.authors,
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
		-- Clamp: KOReader repagination can push furthest_page past the stored
		-- total, which would otherwise render a >100% progress bar.
		else least(1.0, max(s.page)::numeric / b.total_pages)
	end                                     as progress
from public.books b
join public.reading_sessions s on s.book_id = b.id
group by b.id;

comment on view public.book_progress is
	'Per-book rollup. INNER JOIN by design: a book with zero sessions has not been started and should not appear as 0% progress.';

revoke all on public.reading_daily  from anon, authenticated;
revoke all on public.book_progress  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- ingest_reading_sync: the whole of POST /api/reading/sync, in one round trip
-- ---------------------------------------------------------------------------
-- Lives in SQL rather than the API route for three reasons:
--   1. Transaction. The books upsert, the sessions insert and the batch log
--      have to land together or not at all, and PostgREST has no way to wrap
--      three calls in one.
--   2. `coalesce(excluded.x, books.x)` on conflict — a sparse payload must never
--      null out metadata already stored. A PostgREST upsert always writes every
--      column in the row, so it cannot express this.
--   3. One statement instead of N. The first sync after backfilling months of
--      KOReader history is thousands of rows.
--
-- Input is the already-validated payload (see src/lib/reading.ts): the route
-- enforces the batch caps, the shape and the sane-timestamp rules, and this
-- assumes both arrays are clean.
create or replace function public.ingest_reading_sync(
	p_device   text,
	p_books    jsonb,
	p_sessions jsonb
) returns table (
	books_upserted    integer,
	sessions_received integer,
	sessions_inserted integer,
	latest_session_at timestamptz
)
language plpgsql
as $$
declare
	v_books    integer := 0;
	v_received integer := jsonb_array_length(coalesce(p_sessions, '[]'::jsonb));
	v_inserted integer := 0;
	v_latest   timestamptz;
begin
	with incoming_books as (
		-- distinct on: two rows with the same md5 in one payload would make the
		-- DO UPDATE below "affect row a second time", which is a hard error.
		select distinct on (b.md5) b.*
		from jsonb_to_recordset(coalesce(p_books, '[]'::jsonb)) as b(
			md5 text, title text, authors text, series text,
			language text, total_pages integer
		)
		order by b.md5
	),
	upserted as (
		insert into public.books (md5, title, authors, series, language, total_pages)
		select md5, title, authors, series, language, total_pages from incoming_books
		-- DO UPDATE, not DO NOTHING, so RETURNING yields the full md5 -> id map
		-- even for books that were already present.
		on conflict (md5) do update set
			title       = excluded.title,
			authors     = coalesce(excluded.authors,     public.books.authors),
			series      = coalesce(excluded.series,      public.books.series),
			language    = coalesce(excluded.language,    public.books.language),
			total_pages = coalesce(excluded.total_pages, public.books.total_pages),
			updated_at  = now()
		returning id, md5
	),
	incoming_sessions as (
		select * from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb)) as s(
			book_md5 text, page integer, started_at timestamptz,
			duration integer, total_pages integer, device text
		)
	),
	-- md5 -> id for every book the sessions mention: the ones in this payload,
	-- plus any already stored. The plugin can legitimately send sessions for a
	-- book whose metadata it synced weeks ago.
	book_ids as (
		select id, md5 from upserted
		union
		select b.id, b.md5
		from public.books b
		where b.md5 in (select book_md5 from incoming_sessions)
	),
	inserted as (
		insert into public.reading_sessions
			(book_id, page, started_at, duration_seconds, total_pages, device)
		select k.id, s.page, s.started_at, s.duration, s.total_pages,
		       coalesce(s.device, p_device)
		-- INNER JOIN: a session whose book_md5 resolves to nothing is dropped
		-- rather than failing the batch.
		from incoming_sessions s
		join book_ids k on k.md5 = s.book_md5
		on conflict (book_id, page, started_at) do nothing
		returning 1
	)
	select (select count(*) from upserted), (select count(*) from inserted)
	into v_books, v_inserted;

	insert into public.reading_sync_batches
		(device, books_received, sessions_received, sessions_inserted)
	values (
		p_device,
		jsonb_array_length(coalesce(p_books, '[]'::jsonb)),
		v_received,
		v_inserted
	);

	-- Separate statement so it sees the rows just inserted. Same cursor the GET
	-- returns, so the plugin can compare the two.
	select max(s.started_at) into v_latest
	from public.reading_sessions s
	where s.device = p_device;

	return query select v_books, v_received, v_inserted, v_latest;
end;
$$;

comment on function public.ingest_reading_sync(text, jsonb, jsonb) is
	'Idempotent ingest of a KOReader sync batch. sessions_inserted < sessions_received is normal: it is the unique(book_id, page, started_at) constraint discarding resent rows.';

-- ---------------------------------------------------------------------------
-- reading_heatmap: reading_daily with the gaps filled in
-- ---------------------------------------------------------------------------
-- reading_daily has no row for a day with no reading, and a heatmap needs the
-- zeros. generate_series supplies the spine.
create or replace function public.reading_heatmap(p_from date, p_to date)
returns table (
	day           date,
	pages_read    integer,
	seconds_read  integer,
	books_touched integer
)
language sql
stable
as $$
	select
		d::date,
		coalesce(rd.pages_read, 0)::integer,
		coalesce(rd.seconds_read, 0)::integer,
		coalesce(rd.books_touched, 0)::integer
	from generate_series(p_from, p_to, interval '1 day') as d
	left join public.reading_daily rd on rd.day = d::date
	order by 1;
$$;

-- ---------------------------------------------------------------------------
-- reading_stats: streaks and totals
-- ---------------------------------------------------------------------------
-- Streaks are gaps-and-islands: consecutive days share a constant
-- (day - row_number()), so grouping on that difference collapses each unbroken
-- run into one row. A run counts as *current* if it reaches today or yesterday
-- — today's reading may simply not have happened yet.
create or replace function public.reading_stats()
returns table (
	current_streak integer,
	longest_streak integer,
	days_read      integer,
	total_pages    bigint,
	total_seconds  bigint,
	first_day      date,
	last_day       date
)
language sql
stable
as $$
	with grouped as (
		select
			rd.day,
			rd.pages_read,
			rd.seconds_read,
			rd.day - (row_number() over (order by rd.day))::integer as run_key
		from public.reading_daily rd
	),
	runs as (
		select run_key, max(day) as end_day, count(*)::integer as length
		from grouped
		group by run_key
	)
	select
		coalesce((
			select r.length from runs r
			where r.end_day >= (now() at time zone 'America/New_York')::date - 1
			order by r.end_day desc
			limit 1
		), 0),
		coalesce((select max(r.length) from runs r), 0),
		(select count(*)::integer      from grouped),
		(select coalesce(sum(g.pages_read), 0)   from grouped g),
		(select coalesce(sum(g.seconds_read), 0) from grouped g),
		(select min(g.day) from grouped g),
		(select max(g.day) from grouped g);
$$;

-- Server-side only, like the tables they read. The API routes call these with
-- the service-role key.
revoke execute on function public.ingest_reading_sync(text, jsonb, jsonb) from anon, authenticated;
revoke execute on function public.reading_heatmap(date, date)             from anon, authenticated;
revoke execute on function public.reading_stats()                         from anon, authenticated;
