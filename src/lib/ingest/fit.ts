// FIT decoding — ACTIVITIES.md §4's `fit.ts`.
//
// FIT is the format every device in this pipeline can emit (Garmin, Wahoo,
// TrainerRoad all record it natively, and Strava's export carries whatever was
// uploaded), which is why §4 makes it the canonical path and everything else a
// thin adapter. `@garmin/fitsdk` is the official MIT-licensed decoder; nothing
// here re-implements the binary format.
//
// This file's whole job is FIT's vocabulary → ours. It measures, it does not
// derive: no exertion, no route path, no database. See canonical.ts.

import { Decoder, Stream } from '@garmin/fitsdk';
import { refineSport, type CanonicalActivity, type CanonicalLap, type CanonicalStreams } from './canonical';
import type { Sport } from './../sports';

/** FIT stores lat/lng as "semicircles": a signed 32-bit sweep of the globe.
 *  2^31 semicircles is 180°, which is the whole of the conversion. */
const SEMICIRCLE = 180 / 2 ** 31;

/** FIT's own epoch is 1989-12-31T00:00:00Z, not Unix. `localTimestamp` is a
 *  raw FIT timestamp (the SDK leaves it as a number because it is a LOCAL
 *  reading with no zone), while `timestamp` is decoded to a real Date — the
 *  difference between the two is the UTC offset that was in force. */
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

interface FitMessages {
	sessionMesgs?: Record<string, any>[];
	recordMesgs?: Record<string, any>[];
	lapMesgs?: Record<string, any>[];
	activityMesgs?: Record<string, any>[];
	deviceInfoMesgs?: Record<string, any>[];
	fileIdMesgs?: Record<string, any>[];
}

export interface FitParseOptions {
	/** The sport Strava already told us, from activities.csv. The file's own
	 *  sport only refines it (see `refineSport`) — it never overrides, because
	 *  the athlete may have corrected the type on Strava after the upload. */
	sport: Sport;
}

/**
 * Decode one FIT file (already gunzipped) into a canonical activity.
 *
 * Returns null when the buffer isn't a FIT file at all or carries no session
 * message — a handful of files in any long archive are empty uploads, and one
 * of those must skip rather than abort a 1700-file import.
 */
export function parseFit(buf: Buffer | Uint8Array, opts: FitParseOptions): CanonicalActivity | null {
	return parseFitSessions(buf, opts)[0] ?? null;
}

/**
 * Every session in the file, in recorded order.
 *
 * WHY THIS EXISTS. A FIT file usually holds one session and one activity. A
 * MULTISPORT file holds several — a triathlon is swim, transition, bike,
 * transition, run, five sessions in one recording — and Strava's export copies
 * that same whole file once per leg, under a different filename each time.
 * Reading only `sessionMesgs[0]` therefore gives every leg the SWIM's numbers,
 * which is how a half ironman ends up stored five times as a 34-minute
 * 1.9km effort. The records are sliced per session so each leg gets its own
 * track, its own heart rate, and its own exertion.
 */
export function parseFitSessions(buf: Buffer | Uint8Array, opts: FitParseOptions): CanonicalActivity[] {
	const decoder = new Decoder(Stream.fromBuffer(buf));
	if (!decoder.isFIT()) return [];

	// Not checking integrity: a truncated tail (a head unit that ran out of
	// battery mid-save) still decodes every record before the break, and
	// dropping the whole ride over a missing CRC loses real data for nothing.
	const { messages } = decoder.read({ mesgListener: undefined }) as { messages: FitMessages };

	const sessions = messages.sessionMesgs ?? [];
	if (!sessions.length) return [];

	const multisport = sessions.length > 1;
	return sessions
		.map((session) => oneSession(session, messages, opts, multisport))
		.filter((a): a is CanonicalActivity => a !== null);
}

function oneSession(
	session: Record<string, any>,
	messages: FitMessages,
	opts: FitParseOptions,
	multisport: boolean,
): CanonicalActivity | null {
	const startedAt: Date = session.startTime ?? session.timestamp;
	if (!startedAt) return null;

	// Slice the file's records down to this session's window. A single-session
	// file keeps everything, so this costs nothing in the common case.
	const from = new Date(startedAt).getTime();
	const to = from + (num(session.totalElapsedTime) ?? 0) * 1000;
	const allRecords = messages.recordMesgs ?? [];
	const records = multisport
		? allRecords.filter((r) => {
				const t = new Date(r.timestamp).getTime();
				return t >= from && t <= to;
			})
		: allRecords;

	const streams = toStreams(records, startedAt);

	// In a multisport file each session states its own sport, and THAT is the
	// authority for a leg — the csv row for "Sunny 70.3 T1" says "Workout",
	// which is Strava's best guess and not what the leg is.
	const { sport, sub_sport } = multisport
		? { sport: sportFromFit(session.sport, session.subSport) ?? opts.sport, sub_sport: subSportOf(session.subSport) }
		: refineSport(opts.sport, session.sport, session.subSport);

	return {
		sport,
		sub_sport,
		started_at: new Date(startedAt).toISOString(),
		utc_offset_minutes: offsetFromActivityMesg(messages.activityMesgs?.[0]),

		elapsed_seconds: Math.round(num(session.totalElapsedTime) ?? 0),
		moving_seconds: int(session.totalTimerTime),
		distance_m: num(session.totalDistance),
		elevation_gain_m: num(session.totalAscent),
		elevation_loss_m: num(session.totalDescent),
		elev_high_m: num(session.enhancedMaxAltitude ?? session.maxAltitude),
		elev_low_m: num(session.enhancedMinAltitude ?? session.minAltitude),

		avg_speed_ms: num(session.enhancedAvgSpeed ?? session.avgSpeed),
		max_speed_ms: num(session.enhancedMaxSpeed ?? session.maxSpeed),
		avg_hr: int(session.avgHeartRate),
		max_hr: int(session.maxHeartRate),
		avg_cadence: int(session.avgRunningCadence ?? session.avgCadence),
		avg_power_w: int(session.avgPower),
		max_power_w: int(session.maxPower),
		normalized_power_w: int(session.normalizedPower),
		// FIT reports total work in joules; the column is kJ.
		work_kj: session.totalWork ? num(session.totalWork)! / 1000 : null,
		calories: int(session.totalCalories),
		avg_temp_c: num(session.avgTemperature),

		pool_length_m: num(session.poolLength),
		total_strokes: int(session.totalStrokes ?? session.totalCycles),
		avg_swolf: swolf(session),

		device_name: deviceName(messages),
		device_ftp_w: int(session.thresholdPower),

		streams,
		laps: toLaps(
			multisport
				? (messages.lapMesgs ?? []).filter((l) => {
						const t = new Date(l.startTime ?? l.timestamp).getTime();
						return t >= from && t <= to;
					})
				: (messages.lapMesgs ?? []),
			sport,
		),
	};
}

/** A FIT session's own sport vocabulary → ours. Only consulted for a
 *  multisport file's legs, where the file knows better than Strava's label
 *  (see `oneSession`); everything else goes through `refineSport`. */
export function sportFromFit(fitSport?: string, fitSubSport?: string): Sport | null {
	switch (fitSport) {
		case 'swimming':
			return fitSubSport === 'openWater' ? 'open_water_swim' : 'swim';
		case 'transition':
			return 'transition';
		case 'cycling':
			return fitSubSport === 'indoorCycling' || fitSubSport === 'virtualActivity' ? 'virtual_ride' : 'ride';
		case 'running':
			return fitSubSport === 'treadmill' ? 'treadmill_run' : fitSubSport === 'trail' ? 'trail_run' : 'run';
		case 'hiking':
			return 'hike';
		case 'walking':
			return 'walk';
		default:
			return null;
	}
}

const subSportOf = (sub?: string): string | null => (sub && sub !== 'generic' ? sub : null);

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * Records → parallel arrays.
 *
 * Two things are worth knowing here. First, a record message only carries the
 * fields that CHANGED, so the first record of a file is often just a timestamp
 * (seen throughout this archive) — every array is therefore built with a null
 * hole rather than dropped, so index N means the same instant in all of them.
 *
 * Second, `moving` is not a FIT field. Devices signal stops with event
 * messages, but every consumer here (§3's NP and TRIMP) only wants "was the
 * athlete actually going", so it is derived from speed instead: > 0.3 m/s,
 * which is below any real walking pace and above GPS jitter at a standstill.
 */
function toStreams(records: Record<string, any>[], startTime: Date | undefined): CanonicalStreams | undefined {
	if (records.length === 0) return undefined;

	const t0 = startTime ? new Date(startTime).getTime() : new Date(records[0].timestamp).getTime();

	const time_s: number[] = [];
	const latlng: [number, number][] = [];
	const altitude_m: number[] = [];
	const distance_m: number[] = [];
	const heartrate: number[] = [];
	const cadence: number[] = [];
	const power_w: number[] = [];
	const speed_ms: number[] = [];
	const temp_c: number[] = [];
	const grade: number[] = [];
	const moving: boolean[] = [];

	let anyLatLng = false;
	let anyAlt = false;
	let anyDist = false;
	let anyHr = false;
	let anyCad = false;
	let anyPower = false;
	let anySpeed = false;
	let anyTemp = false;
	let anyGrade = false;

	for (const r of records) {
		time_s.push(Math.round((new Date(r.timestamp).getTime() - t0) / 1000));

		const lat = r.positionLat;
		const lng = r.positionLong;
		if (typeof lat === 'number' && typeof lng === 'number') {
			latlng.push([lat * SEMICIRCLE, lng * SEMICIRCLE]);
			anyLatLng = true;
		} else {
			latlng.push([NaN, NaN]);
		}

		const alt = r.enhancedAltitude ?? r.altitude;
		altitude_m.push(numOrNaN(alt));
		if (Number.isFinite(alt)) anyAlt = true;

		distance_m.push(numOrNaN(r.distance));
		if (Number.isFinite(r.distance)) anyDist = true;

		heartrate.push(numOrNaN(r.heartRate));
		if (Number.isFinite(r.heartRate)) anyHr = true;

		cadence.push(numOrNaN(r.cadence));
		if (Number.isFinite(r.cadence)) anyCad = true;

		power_w.push(numOrNaN(r.power));
		if (Number.isFinite(r.power)) anyPower = true;

		const spd = r.enhancedSpeed ?? r.speed;
		speed_ms.push(numOrNaN(spd));
		if (Number.isFinite(spd)) anySpeed = true;

		temp_c.push(numOrNaN(r.temperature));
		if (Number.isFinite(r.temperature)) anyTemp = true;

		grade.push(numOrNaN(r.grade));
		if (Number.isFinite(r.grade)) anyGrade = true;

		moving.push(Number.isFinite(spd) ? (spd as number) > 0.3 : true);
	}

	const out: CanonicalStreams = { time_s };
	if (anyLatLng) out.latlng = latlng.map(([a, b]) => [nanToNull(a), nanToNull(b)] as unknown as [number, number]);
	if (anyAlt) out.altitude_m = nulled(altitude_m);
	if (anyDist) out.distance_m = nulled(distance_m);
	if (anyHr) out.heartrate = nulled(heartrate);
	if (anyCad) out.cadence = nulled(cadence);
	if (anyPower) out.power_w = nulled(power_w);
	if (anySpeed) out.speed_ms = nulled(speed_ms);
	if (anyTemp) out.temp_c = nulled(temp_c);
	if (anyGrade) out.grade = nulled(grade);
	if (anySpeed) out.moving = moving;
	return out;
}

// ---------------------------------------------------------------------------
// Laps
// ---------------------------------------------------------------------------

function toLaps(laps: Record<string, any>[], sport: Sport): CanonicalLap[] {
	return laps.map((l, i) => ({
		lap_index: i + 1,
		start_time: l.startTime ? new Date(l.startTime).toISOString() : null,
		elapsed_seconds: int(l.totalElapsedTime),
		moving_seconds: int(l.totalTimerTime),
		distance_m: num(l.totalDistance),
		avg_hr: int(l.avgHeartRate),
		max_hr: int(l.maxHeartRate),
		avg_power_w: int(l.avgPower),
		avg_speed_ms: num(l.enhancedAvgSpeed ?? l.avgSpeed),
		elevation_gain_m: num(l.totalAscent),
		// A pool swim's "laps" are lengths, which is a different thing from an
		// interval and is worth keeping distinguishable — the schema has the
		// type for exactly this.
		lap_type: sport === 'swim' && l.lengthType ? ('length' as const) : ('lap' as const),
	}));
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function offsetFromActivityMesg(activity: Record<string, any> | undefined): number | null {
	if (!activity || typeof activity.localTimestamp !== 'number' || !activity.timestamp) return null;
	const utcMs = new Date(activity.timestamp).getTime();
	const localMs = FIT_EPOCH_MS + activity.localTimestamp * 1000;
	const offset = Math.round((localMs - utcMs) / 60000);
	// Sanity: real offsets are within ±14h and land on a quarter hour. Anything
	// else means the field was garbage, and a wrong offset silently files the
	// activity on the wrong day, so refuse it and let the home-zone fallback run.
	if (Math.abs(offset) > 14 * 60 || offset % 15 !== 0) return null;
	return offset;
}

function deviceName(messages: FitMessages): string | null {
	const creator = messages.deviceInfoMesgs?.find((d) => d.deviceIndex === 'creator');
	const named = creator ?? messages.deviceInfoMesgs?.find((d) => d.productName);
	if (named?.productName) return String(named.productName);
	const manufacturer = messages.fileIdMesgs?.[0]?.manufacturer;
	return manufacturer ? String(manufacturer) : null;
}

/** SWOLF is a stroke count plus the seconds for the length. Devices that
 *  report it do so per length, so a session average is only available when the
 *  file carries it directly — computing one from totals would be a different
 *  number wearing the same name. */
function swolf(session: Record<string, any>): number | null {
	return int(session.avgSwolf ?? session.avgSwimSwolf);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const numOrNaN = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const nanToNull = (v: number): number | null => (Number.isFinite(v) ? v : null);
const nulled = (arr: number[]): number[] => arr.map((v) => (Number.isFinite(v) ? v : null)) as unknown as number[];
