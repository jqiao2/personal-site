// Strava API → canonical — ACTIVITIES.md §4 step 3's parser.
//
// The archive path (strava-archive.ts) reads a CSV plus a device file; this
// reads Strava's JSON instead. Different container, same job: turn what the
// provider said into a `CanonicalActivity`, and let `toRows` do the derived
// things (exertion, route, local date). No exertion or DB access here.
//
// Two API shapes come in: the DetailedActivity (one GET per activity, carries
// laps, gear_id, calories, description) and the streams object (a second GET,
// the per-sample arrays). Both are mapped here.
import type { CanonicalActivity, CanonicalLap, CanonicalStreams } from '../canonical';
import { sportFromXmlType, UnknownSportError } from '../canonical';

// The subset of Strava's DetailedActivity we read. Everything is optional —
// an indoor trainer ride has no latlng, a swim no power.
export interface StravaActivity {
	id: number;
	name?: string;
	description?: string | null;
	type?: string;
	sport_type?: string;
	start_date: string; // ISO UTC
	utc_offset?: number; // seconds east of UTC
	timezone?: string; // "(GMT-08:00) America/Los_Angeles"
	elapsed_time: number;
	moving_time?: number;
	distance?: number;
	total_elevation_gain?: number;
	elev_high?: number;
	elev_low?: number;
	average_speed?: number;
	max_speed?: number;
	average_heartrate?: number;
	max_heartrate?: number;
	average_cadence?: number;
	average_watts?: number;
	max_watts?: number;
	weighted_average_watts?: number;
	kilojoules?: number;
	calories?: number;
	average_temp?: number;
	device_name?: string | null;
	gear_id?: string | null;
	laps?: StravaLap[] | null;
}

interface StravaLap {
	lap_index?: number;
	name?: string | null;
	start_date?: string | null;
	elapsed_time?: number | null;
	moving_time?: number | null;
	distance?: number | null;
	average_heartrate?: number | null;
	max_heartrate?: number | null;
	average_watts?: number | null;
	average_speed?: number | null;
	total_elevation_gain?: number | null;
}

/** The `key_by_type=true` streams object: `{ time: { data: [...] }, ... }`. */
export type StravaStreams = Record<string, { data?: unknown[] } | undefined>;

const num = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The Strava `timezone` string is "(GMT-08:00) America/Los_Angeles" — the IANA
 *  name is everything after the space. */
function ianaZone(tz: string | undefined): string | null {
	if (!tz) return null;
	const sp = tz.indexOf(' ');
	return sp >= 0 ? tz.slice(sp + 1).trim() : tz.trim();
}

function numberArray(s: StravaStreams, key: string): number[] | undefined {
	const data = s[key]?.data;
	if (!Array.isArray(data) || !data.length) return undefined;
	return data.map((v) => (typeof v === 'number' ? v : NaN));
}

function mapStreams(s: StravaStreams | null | undefined): CanonicalStreams | undefined {
	if (!s) return undefined;
	const out: CanonicalStreams = {};
	out.time_s = numberArray(s, 'time');
	out.altitude_m = numberArray(s, 'altitude');
	out.distance_m = numberArray(s, 'distance');
	out.heartrate = numberArray(s, 'heartrate');
	out.cadence = numberArray(s, 'cadence');
	out.power_w = numberArray(s, 'watts');
	out.speed_ms = numberArray(s, 'velocity_smooth');
	out.temp_c = numberArray(s, 'temp');
	out.grade = numberArray(s, 'grade_smooth');

	const latlng = s.latlng?.data;
	if (Array.isArray(latlng) && latlng.length) {
		out.latlng = latlng.map((p) =>
			Array.isArray(p) && p.length >= 2 ? ([Number(p[0]), Number(p[1])] as [number, number]) : [NaN, NaN],
		);
	}
	const moving = s.moving?.data;
	if (Array.isArray(moving) && moving.length) out.moving = moving.map((v) => Boolean(v));

	// Drop the keys that came back empty so `toRows` sees the same "absent means
	// the sensor wasn't there" shape the file parsers produce.
	for (const k of Object.keys(out) as (keyof CanonicalStreams)[]) if (out[k] === undefined) delete out[k];
	return Object.keys(out).length ? out : undefined;
}

function mapLaps(laps: StravaLap[] | null | undefined): CanonicalLap[] | undefined {
	if (!laps?.length) return undefined;
	return laps.map((l, i) => ({
		lap_index: l.lap_index ?? i + 1,
		name: l.name ?? null,
		start_time: l.start_date ?? null,
		elapsed_seconds: num(l.elapsed_time),
		moving_seconds: num(l.moving_time),
		distance_m: num(l.distance),
		avg_hr: num(l.average_heartrate),
		max_hr: num(l.max_heartrate),
		avg_power_w: num(l.average_watts),
		avg_speed_ms: num(l.average_speed),
		elevation_gain_m: num(l.total_elevation_gain),
		lap_type: 'lap',
	}));
}

/**
 * DetailedActivity (+ optional streams) → canonical.
 *
 * Sport comes from `sport_type` (Strava's newer, finer field — "GravelRide",
 * "TrailRun") falling back to `type`. Both use the squashed CamelCase that
 * `sportFromXmlType` already normalises, so the archive's sport table is
 * reused rather than copied. An unmapped sport throws, exactly as the archive
 * path does (canonical.ts's UnknownSportError note): a silent fall to 'other'
 * is a permanent lossy write, so the sync stops and asks for the slug instead.
 */
export function activityToCanonical(a: StravaActivity, streams?: StravaStreams | null): CanonicalActivity {
	const typeStr = a.sport_type ?? a.type;
	const sport = sportFromXmlType(typeStr);
	if (!sport) throw new UnknownSportError(typeStr ?? '(none)');

	return {
		sport,
		title: a.name ?? null,
		notes: a.description ?? null,
		started_at: new Date(a.start_date).toISOString(),
		utc_offset_minutes: typeof a.utc_offset === 'number' ? Math.round(a.utc_offset / 60) : null,
		timezone: ianaZone(a.timezone),

		elapsed_seconds: Math.round(a.elapsed_time),
		moving_seconds: num(a.moving_time),
		distance_m: num(a.distance),
		elevation_gain_m: num(a.total_elevation_gain),
		elev_high_m: num(a.elev_high),
		elev_low_m: num(a.elev_low),

		avg_speed_ms: num(a.average_speed),
		max_speed_ms: num(a.max_speed),
		avg_hr: num(a.average_heartrate),
		max_hr: num(a.max_heartrate),
		avg_cadence: num(a.average_cadence),
		avg_power_w: num(a.average_watts),
		max_power_w: num(a.max_watts),
		normalized_power_w: num(a.weighted_average_watts),
		work_kj: num(a.kilojoules),
		calories: num(a.calories),
		avg_temp_c: num(a.average_temp),

		device_name: a.device_name ?? null,
		streams: mapStreams(streams),
		laps: mapLaps(a.laps),
	};
}
