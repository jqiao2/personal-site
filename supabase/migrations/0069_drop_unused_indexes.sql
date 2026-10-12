-- Drop every non-unique index the planner has never used (pg_stat_user_indexes
-- idx_scan = 0 on 2026-10-12, stats never reset). About 41 MB, most of it the
-- credit graph and the gazetteer:
--   credit_people_name_idx   nothing looks people up by name
--   credits_film_idx         redundant: credits_pkey (film_id, person_id, role) leads with film_id
--   place_sources_lat/lng    gazetteer.ts reads lat/lng but never filters on them
-- The rest sit on tables small enough that a sequential scan always wins.
-- Unique and primary-key indexes stay; they enforce constraints and back upserts.
-- Add an index back when a query actually needs one (EXPLAIN shows a seq scan
-- that hurts), not ahead of it.

drop index if exists public.credit_people_name_idx;
drop index if exists public.credits_film_idx;
drop index if exists public.place_sources_lng_idx;
drop index if exists public.place_sources_lat_idx;
drop index if exists public.credit_films_countries_idx;
drop index if exists public.credit_films_vote_count_idx;
drop index if exists public.credit_films_revenue_idx;
drop index if exists public.reading_sessions_device_started_idx;
drop index if exists public.reading_sessions_book_started_idx;
drop index if exists public.reading_sessions_started_at_idx;
drop index if exists public.reading_sync_batches_received_idx;
drop index if exists public.activities_exertion_idx;
drop index if exists public.activities_tags_idx;
drop index if exists public.activities_private_idx;
drop index if exists public.activities_gear_id_idx;
drop index if exists public.activities_sport_idx;
drop index if exists public.activity_gear_kind_idx;
drop index if exists public.gear_components_current_idx;
drop index if exists public.gear_components_gear_id_idx;
drop index if exists public.movies_title_idx;
drop index if exists public.movies_credits_synced_at_idx;
drop index if exists public.logs_log_idx;
drop index if exists public.logs_format_id_idx;
drop index if exists public.logs_theater_id_idx;
drop index if exists public.logs_deleted_at_idx;
drop index if exists public.log_friends_friend_id_idx;
drop index if exists public.log_tags_tag_id_idx;
drop index if exists public.screening_queue_date_idx;
drop index if exists public.screening_queue_event_idx;
drop index if exists public.restaurants_name_idx;
drop index if exists public.restaurants_cuisines_idx;
drop index if exists public.restaurants_to_try_tags_idx;
drop index if exists public.restaurants_city_idx;
drop index if exists public.restaurants_to_try_idx;
drop index if exists public.restaurants_borough_idx;
drop index if exists public.restaurants_merged_into_idx;
drop index if exists public.restaurants_trip_idx;
drop index if exists public.restaurant_visits_tags_idx;
drop index if exists public.restaurant_visits_friends_idx;
drop index if exists public.book_reviews_book_idx;
drop index if exists public.book_highlights_book_idx;
