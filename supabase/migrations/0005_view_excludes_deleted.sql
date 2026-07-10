-- Recreate logs_with_movie to exclude soft-deleted rows (deleted_at was added in
-- 0004). This makes the view a correct read model for the diary list, so
-- listLogs can select from it directly instead of filtering in application code.
-- Same columns as 0002, plus a WHERE clause — so CREATE OR REPLACE is valid.

create or replace view public.logs_with_movie as
select
	l.id,
	l.watched_date,
	l.log,
	l.rating,
	l.review_text,
	l.rewatched,
	l.liked,
	l.created_at,
	m.tmdb_id,
	m.title,
	m.release_year,
	m.poster_path,
	coalesce(
		(select array_agg(t.name order by t.name)
		 from public.log_tags lt
		 join public.tags t on t.id = lt.tag_id
		 where lt.log_id = l.id),
		'{}'
	) as tags
from public.logs l
join public.movies m on m.id = l.movie_id
where l.deleted_at is null;
