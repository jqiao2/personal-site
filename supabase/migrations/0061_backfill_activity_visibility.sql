-- Backfill activity visibility: public unless it happened during work hours.
--
-- 0043 defaulted every activity to private, which was the only safe default but
-- left the whole log hidden. The thing actually worth hiding is a workout that
-- overlaps the working day — Mon–Fri 09:00–17:00 LOCAL time, local because a
-- run at 06:00 in Tokyo is not a run at 21:00 UTC. Everything else goes public.
--
-- Overlap, not start time: a ride that starts at 08:30 and ends at 10:15 was a
-- ride during work hours. Only the two endpoints are tested, which misses an
-- activity long enough to swallow a whole 09:00–17:00 window without either end
-- landing inside one. That needs ≥16h (Mon 17:00 → Tue 09:00), so anything that
-- long simply stays private rather than being reasoned about.
--
-- Unknown local time (no utc_offset_minutes and no timezone) stays private too.
-- This only ever flips private → public on rows that pass; nothing already
-- public is touched, so re-running it is a no-op.
--
-- Holidays and vacation days are not modelled. A workout on a Monday off is
-- treated as work hours and stays private; flip those by hand.
update public.activities a
set private = false
from (
	select
		s.id
	from (
		select
			id,
			case
				when utc_offset_minutes is not null
					then (started_at at time zone 'UTC') + make_interval(mins => utc_offset_minutes)
				when timezone is not null
					then started_at at time zone timezone
			end as local_start,
			elapsed_seconds
		from public.activities
		where deleted_at is null
			and private
	) s
	where s.local_start is not null
		and s.elapsed_seconds < 16 * 3600
		and not exists (
			select 1
			from unnest(array[
				s.local_start,
				s.local_start + make_interval(secs => s.elapsed_seconds)
			]) as t
			where extract(isodow from t) between 1 and 5
				and t::time >= time '09:00'
				and t::time < time '17:00'
		)
) pub
where a.id = pub.id;
