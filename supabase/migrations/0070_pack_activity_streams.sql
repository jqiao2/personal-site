-- activity_streams: JSONB arrays -> delta-encoded fixed-point int[] (≈144 MB -> ≈60 MB).
--
-- JSONB text and plain float arrays both compress badly; the gaps between
-- consecutive samples are small and repeat (time_s is almost all 1s), so TOAST
-- compression takes an int[] of deltas to about a third of the JSONB size.
-- Sample N holds round(v * scale) minus the previous non-null sample's; a null
-- sample stays null. Scales match what canonical.ts already stores (6dp latlng,
-- 0.1 m altitude/distance, 1 cm/s speed, 0.01 grade, 0.1 °C), so nothing is
-- lost; the migration decodes every row and aborts on any mismatch.
-- src/lib/stream-codec.ts is the read/write side; columns are renamed to
-- `<stream>_packed` so nothing can read the deltas as plain values.
--
-- Rebuilt as a new table rather than updated in place: an UPDATE leaves the old
-- TOAST behind as dead tuples, and getting the space back would need a
-- VACUUM FULL. Nothing references this table (no views, FKs or functions).

set statement_timeout = 0;

-- One row broke "nothing is lost": activity 3497, a 2021 hike imported from a
-- Strava GPX, has interpolated heart rate and cadence (122.7 bpm, 54.2 rpm) on
-- 219 and 664 of its 1184 samples. Sensors report whole numbers, so these are
-- rounded to the integers every other activity already holds (each moves by
-- under 0.5), and the check below then holds for every row.
update public.activity_streams
set heartrate = (
		select jsonb_agg(case when jsonb_typeof(e) = 'number' then to_jsonb(round((e #>> '{}')::numeric)) else e end order by i)
		from jsonb_array_elements(heartrate) with ordinality x(e, i)
	),
	cadence = (
		select jsonb_agg(case when jsonb_typeof(e) = 'number' then to_jsonb(round((e #>> '{}')::numeric)) else e end order by i)
		from jsonb_array_elements(cadence) with ordinality x(e, i)
	)
where activity_id = 3497;

create function pg_temp.stream_pack(a jsonb, scale numeric) returns int[]
language plpgsql immutable as $$
declare
	out int[] := '{}';
	prev bigint := 0;
	q bigint;
	e jsonb;
begin
	if a is null or jsonb_typeof(a) <> 'array' then return null; end if;

	for e in select x.e from jsonb_array_elements(a) with ordinality x(e, i) order by x.i loop
		if jsonb_typeof(e) <> 'number' then
			out := out || null::int;
		else
			q := round((e #>> '{}')::numeric * scale);
			out := out || (q - prev)::int;
			prev := q;
		end if;
	end loop;

	return out;
end $$;

create function pg_temp.stream_unpack(a int[], scale numeric) returns numeric[]
language plpgsql immutable as $$
declare
	out numeric[] := '{}';
	acc bigint := 0;
	d int;
begin
	if a is null then return null; end if;

	foreach d in array a loop
		if d is null then
			out := out || null::numeric;
		else
			acc := acc + d;
			out := out || (acc / scale);
		end if;
	end loop;

	return out;
end $$;

-- The JSONB array as numeric[], for the check below. Non-numbers become null.
create function pg_temp.stream_plain(a jsonb) returns numeric[]
language sql immutable as $$
	select case when jsonb_typeof(a) = 'array' then array(
		select case when jsonb_typeof(e) = 'number' then (e #>> '{}')::numeric end
		from jsonb_array_elements(a) with ordinality x(e, i) order by i
	) end
$$;

create table public.activity_streams_packed (
	activity_id       bigint  primary key references public.activities (id) on delete cascade,
	sample_count      integer not null,
	time_s_packed     int[],  -- seconds          x1
	lat_packed        int[],  -- degrees          x1e6
	lng_packed        int[],  -- degrees          x1e6
	altitude_m_packed int[],  -- metres           x10
	distance_m_packed int[],  -- metres           x10
	heartrate_packed  int[],  -- bpm              x1
	cadence_packed    int[],  -- rpm / spm        x1
	power_w_packed    int[],  -- watts            x1
	speed_ms_packed   int[],  -- metres/second    x100
	temp_c_packed     int[],  -- °C               x10
	grade_packed      int[],  -- percent          x100
	moving            boolean[]
);

insert into public.activity_streams_packed
select
	activity_id,
	sample_count,
	pg_temp.stream_pack(time_s, 1),
	pg_temp.stream_pack(jsonb_path_query_array(latlng, '$[*][0]'), 1e6),
	pg_temp.stream_pack(jsonb_path_query_array(latlng, '$[*][1]'), 1e6),
	pg_temp.stream_pack(altitude_m, 10),
	pg_temp.stream_pack(distance_m, 10),
	pg_temp.stream_pack(heartrate, 1),
	pg_temp.stream_pack(cadence, 1),
	pg_temp.stream_pack(power_w, 1),
	pg_temp.stream_pack(speed_ms, 100),
	pg_temp.stream_pack(temp_c, 10),
	pg_temp.stream_pack(grade, 100),
	case when jsonb_typeof(moving) = 'array' then array(
		select (e #>> '{}')::boolean from jsonb_array_elements(moving) with ordinality x(e, i) order by i
	) end
from public.activity_streams;

-- Decode every row and compare with the original. Array `=` treats two nulls
-- as equal, and `is not distinct from` covers a whole-column null.
do $$
declare
	bad int;
begin
	select count(*) into bad
	from public.activity_streams o
	join public.activity_streams_packed p using (activity_id)
	where pg_temp.stream_unpack(p.time_s_packed, 1)         is distinct from pg_temp.stream_plain(o.time_s)
	   or pg_temp.stream_unpack(p.lat_packed, 1e6)          is distinct from pg_temp.stream_plain(jsonb_path_query_array(o.latlng, '$[*][0]'))
	   or pg_temp.stream_unpack(p.lng_packed, 1e6)          is distinct from pg_temp.stream_plain(jsonb_path_query_array(o.latlng, '$[*][1]'))
	   or pg_temp.stream_unpack(p.altitude_m_packed, 10)    is distinct from pg_temp.stream_plain(o.altitude_m)
	   or pg_temp.stream_unpack(p.distance_m_packed, 10)    is distinct from pg_temp.stream_plain(o.distance_m)
	   or pg_temp.stream_unpack(p.heartrate_packed, 1)      is distinct from pg_temp.stream_plain(o.heartrate)
	   or pg_temp.stream_unpack(p.cadence_packed, 1)        is distinct from pg_temp.stream_plain(o.cadence)
	   or pg_temp.stream_unpack(p.power_w_packed, 1)        is distinct from pg_temp.stream_plain(o.power_w)
	   or pg_temp.stream_unpack(p.speed_ms_packed, 100)     is distinct from pg_temp.stream_plain(o.speed_ms)
	   or pg_temp.stream_unpack(p.temp_c_packed, 10)        is distinct from pg_temp.stream_plain(o.temp_c)
	   or pg_temp.stream_unpack(p.grade_packed, 100)        is distinct from pg_temp.stream_plain(o.grade)
	   or cardinality(p.moving) is distinct from (case when jsonb_typeof(o.moving) = 'array' then jsonb_array_length(o.moving) end);

	if bad > 0 then
		raise exception 'activity_streams packing is lossy for % rows', bad;
	end if;

	if (select count(*) from public.activity_streams) <> (select count(*) from public.activity_streams_packed) then
		raise exception 'activity_streams row count changed while packing';
	end if;
end $$;

drop table public.activity_streams;
alter table public.activity_streams_packed rename to activity_streams;
alter table public.activity_streams rename constraint activity_streams_packed_pkey to activity_streams_pkey;
alter table public.activity_streams rename constraint activity_streams_packed_activity_id_fkey to activity_streams_activity_id_fkey;

alter table public.activity_streams enable row level security;
create policy "public read activity_streams" on public.activity_streams for select using (true);

comment on table public.activity_streams is
	'One row per activity, keyed 1:1 on activity_id. Each *_packed column is a fixed-point int[] of deltas between consecutive samples; scales and decoding live in src/lib/stream-codec.ts. Deliberately excluded from activity_list: these arrays run to thousands of samples and only the detail page reads them.';
