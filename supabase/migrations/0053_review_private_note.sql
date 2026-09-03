-- A private note on a book review — the reading-log twin of the film log's
-- logs.private_note (0052). `review_text` is the opinion that gets published on
-- a public book's page; this is the part of the read that is nobody else's
-- business, and it stays private even when the book is public.
--
-- No public read model to keep it out of: book reviews are only ever fetched by
-- getBookReviews, which runs under the service role, so the boundary is the
-- application code, not a view grant. getBookReviews(bookId, includePrivate)
-- selects this column only when the caller has proved it is the owner.
alter table public.book_reviews add column if not exists private_note text;

comment on column public.book_reviews.private_note is
	'Owner-only note on a read. Never selected by a visitor-reachable read; see getBookReviews includePrivate.';
