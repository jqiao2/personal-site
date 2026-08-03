-- Close the reading-tracker functions to unauthenticated callers, properly.
--
-- 0020 ended with `revoke execute … from anon, authenticated`, which is not
-- enough: Postgres grants EXECUTE on a new function to PUBLIC, and revoking
-- from two roles that inherit it leaves the PUBLIC grant standing. Verified
-- against the live database — anon could still call ingest_reading_sync, and
-- only RLS on the tables underneath stopped the write from landing.
--
-- Nothing was exposed (the insert failed, and the read-only functions hit
-- security_invoker views anon cannot select from), but "one deliberate mistake
-- away from public writes" is not where these should sit. Revoke from PUBLIC,
-- which is the grant that actually exists, and leave service_role — the key the
-- API routes use — as the only caller.
--
-- Split out rather than folded into 0020 because 0020 has already been applied;
-- an edit there would never run against the live database. Applying both in
-- order, or 0020 alone on a fresh project followed by this, lands identically.

revoke execute on function public.ingest_reading_sync(text, jsonb, jsonb) from public;
revoke execute on function public.reading_heatmap(date, date)             from public;
revoke execute on function public.reading_stats()                         from public;

grant execute on function public.ingest_reading_sync(text, jsonb, jsonb) to service_role;
grant execute on function public.reading_heatmap(date, date)             to service_role;
grant execute on function public.reading_stats()                         to service_role;
