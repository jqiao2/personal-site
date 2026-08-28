// The shape every provider is converted into before anything is stored —
// ACTIVITIES.md §4's "canonical Activity + Streams".
//
// WHY A CANONICAL SHAPE AT ALL, given that only one importer exists today.
// Because the schema has six tables and five providers are coming, and the
// alternative is that each provider learns to write `activities`,
// `activity_streams`, `activity_laps` and `activity_sources` itself. Then the
// day `avg_swolf` changes meaning, four parsers have to agree about it. Here a
// parser's whole job is "turn your file into this", and exactly one function
// (`toRows`) knows what a database row looks like.
//
// The split that matters: a PARSER produces measurements (what the file says),
// and `toRows` produces the record (what we store, including the derived
// things — exertion, the normalised route path, the local calendar date). No
// parser computes exertion, and no parser touches the database. That is what
// makes it possible to re-run §3's cascade over the whole table when a
// threshold changes without re-reading a single FIT file.

import { computeExertion, type Thresholds } from './../exertion';
import { encodePolyline, routePath, bounds } from './../route-shape';
import { SPORT_META, type Sport } from './../sports';

// ---------------------------------------------------------------------------
// The canonical shapes
// ---------------------------------------------------------------------------

/** Per-sample arrays, all parallel and all optional. A trainer ride has power
 *  and no latlng; a treadmill run has heartrate and no altitude; a 2016 GPX
 *  has latlng and nothing else. Every consumer must cope with a missing one,
 *  which is why these are optional rather than empty-array-filled. */
export interface CanonicalStreams {
	time_s?: number[];
	latlng?: [number, number][];
	altitude_m?: number[];
	distance_m?: number[];
	heartrate?: number[];
	cadence?: number[];
	power_w?: number[];
	speed_ms?: number[];
	temp_c?: number[];
	grade?: number[];
	moving?: boolean[];
}

export interface CanonicalLap {
	lap_index: number;
	name?: string | null;
	start_time?: string | null;
	elapsed_seconds?: number | null;
	moving_seconds?: number | null;
	distance_m?: number | null;
	avg_hr?: number | null;
	max_hr?: number | null;
	avg_power_w?: number | null;
	avg_speed_ms?: number | null;
	elevation_gain_m?: number | null;
	lap_type?: 'lap' | 'interval' | 'rest' | 'transition' | 'length';
}

/** What a parser produces. Deliberately close to the `activities` columns —
 *  the mapping is meant to be boring — but with the DERIVED columns absent:
 *  no exertion, no route_path, no local_date. Those are `toRows`' business. */
export interface CanonicalActivity {
	sport: Sport;
	sub_sport?: string | null;

	title?: string | null;
	notes?: string | null;
	private_notes?: string | null;

	/** ISO instant. The one field no activity can be stored without. */
	started_at: string;
	/** Minutes east of UTC at the start. Null when the file doesn't say and
	 *  the caller has no better idea — `toRows` then falls back, see
	 *  `localDate`. */
	utc_offset_minutes?: number | null;
	timezone?: string | null;

	elapsed_seconds: number;
	moving_seconds?: number | null;
	distance_m?: number | null;
	elevation_gain_m?: number | null;
	elevation_loss_m?: number | null;
	elev_high_m?: number | null;
	elev_low_m?: number | null;

	avg_speed_ms?: number | null;
	max_speed_ms?: number | null;
	avg_hr?: number | null;
	max_hr?: number | null;
	avg_cadence?: number | null;
	avg_power_w?: number | null;
	max_power_w?: number | null;
	normalized_power_w?: number | null;
	work_kj?: number | null;
	calories?: number | null;
	avg_temp_c?: number | null;

	pool_length_m?: number | null;
	total_strokes?: number | null;
	avg_swolf?: number | null;

	device_name?: string | null;

	streams?: CanonicalStreams;
	laps?: CanonicalLap[];

	/** Thresholds the recording device itself reported (FIT sessions carry the
	 *  FTP that was set on the head unit). Not stored on the activity — the
	 *  importer collects these to seed `athlete_thresholds`, which is the only
	 *  honest source for an FTP history nobody wrote down at the time. */
	device_ftp_w?: number | null;
}

// ---------------------------------------------------------------------------
// Sport mapping
// ---------------------------------------------------------------------------

/**
 * Strava's `Activity Type` (from the archive's activities.csv) → our slug.
 *
 * WHY THIS THROWS ON AN UNKNOWN TYPE instead of falling back to 'other'.
 * `sportMeta()` deliberately degrades to 'other' so an unrecognised slug can
 * never 500 a page — that is a RENDERING safety net, and it must stay. Using
 * the same fallback at INGEST time would be a different thing entirely: a
 * silent, permanent, lossy write. Thirty activities land in 'other', nobody
 * ever notices, and the sport-aware detail page has nothing to lead with. So
 * the importer stops and asks for the table to be extended, which is a
 * two-minute edit to sports.ts and the reason `inline_skate` and `kayak`
 * exist at all.
 */
const STRAVA_SPORTS: Record<string, Sport> = {
	Ride: 'ride',
	'Gravel Ride': 'gravel_ride',
	'Mountain Bike Ride': 'mountain_bike',
	'Mountain Biking': 'mountain_bike',
	'Virtual Ride': 'virtual_ride',
	'E-Bike Ride': 'ride',
	Run: 'run',
	'Trail Run': 'trail_run',
	'Virtual Run': 'treadmill_run',
	Swim: 'swim',
	Hike: 'hike',
	Walk: 'walk',
	Snowshoe: 'snowshoe',
	'Alpine Ski': 'alpine_ski',
	'Backcountry Ski': 'backcountry_ski',
	'Nordic Ski': 'nordic_ski',
	Snowboard: 'snowboard',
	'Inline Skate': 'inline_skate',
	Kayaking: 'kayak',
	Canoeing: 'kayak',
	Rowing: 'rowing',
	'Weight Training': 'strength',
	Workout: 'strength',
	Yoga: 'yoga',
};

export class UnknownSportError extends Error {
	readonly providerType: string;
	constructor(providerType: string) {
		super(
			`Unknown activity type ${JSON.stringify(providerType)}. Add a slug for it to ` +
				`src/lib/sports.ts (Sport union, SPORTS order, SPORT_META with a MET value) ` +
				`and map it in STRAVA_SPORTS — do not fall back to 'other'.`,
		);
		this.name = 'UnknownSportError';
		this.providerType = providerType;
	}
}

export function sportFromStrava(providerType: string): Sport {
	const slug = STRAVA_SPORTS[providerType.trim()];
	if (!slug) throw new UnknownSportError(providerType);
	return slug;
}

/**
 * A single-activity GPX/TCX download's `<type>` → our slug.
 *
 * Strava writes the same vocabulary as `activities.csv` but squashed —
 * `Gravel Ride` comes down as `gravelride`, `Trail Run` as `trailrun`, and
 * older files use the plain lowercase word. So the table above is reused with
 * its keys normalised rather than copied and drifted. Returns null instead of
 * throwing: a dropped file's type is a hint, and the caller has a `--sport`
 * override to fall back on.
 *
 * A file Strava never touched uses FIT's words instead, so `sportFromFit`
 * closes the chain.
 */
const STRAVA_SPORTS_SQUASHED: Record<string, Sport> = Object.fromEntries(
	Object.entries(STRAVA_SPORTS).map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ''), v]),
);

/** TCX has its own three-word vocabulary in `<Activity Sport="Biking">`.
 *  `Other` is deliberately absent — it means the file doesn't know, which is
 *  the case `--sport` exists for. */
const TCX_SPORTS: Record<string, Sport> = { biking: 'ride', running: 'run' };

/**
 * A FIT session's own sport vocabulary → ours. Consulted for a multisport
 * file's legs, where the file knows better than Strava's label (see fit.ts's
 * `oneSession`); everything else from a FIT file goes through `refineSport`.
 *
 * It is ALSO the last resort for a GPX/TCX `<type>`, because this is the
 * vocabulary a device writes when it isn't Strava doing the writing — a head
 * unit exporting straight to GPX says `cycling`, not `Ride`. Same words, two
 * containers; one table.
 */
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
		case 'training':
			return 'strength';
		case 'rowing':
			return 'rowing';
		case 'paddling':
			return 'kayak';
		case 'alpineSkiing':
			return 'alpine_ski';
		case 'crossCountrySkiing':
			return 'nordic_ski';
		case 'snowboarding':
			return 'snowboard';
		case 'snowshoeing':
			return 'snowshoe';
		case 'inlineSkating':
			return 'inline_skate';
		default:
			return null;
	}
}

export function sportFromXmlType(type: string | null | undefined): Sport | null {
	if (!type) return null;
	const key = type.toLowerCase().replace(/[^a-z]/g, '');
	return STRAVA_SPORTS_SQUASHED[key] ?? TCX_SPORTS[key] ?? sportFromFit(type.trim()) ?? null;
}

/**
 * A FIT file's sport/subSport refines what the CSV already told us; it never
 * overrides it. Strava's own type is the authority because it covers all 1773
 * rows including the ones with no file at all, and because the owner may have
 * corrected it on Strava after the fact — the head unit's guess is older
 * information than the athlete's own correction.
 *
 * The one thing the file knows better is INDOORS: a ride recorded as
 * `indoorCycling` is a trainer ride whatever Strava's label says, and that
 * decides whether the card draws a route or gives its face to the stats (§7).
 */
export function refineSport(sport: Sport, fitSport?: string, fitSubSport?: string): { sport: Sport; sub_sport: string | null } {
	const sub = fitSubSport && fitSubSport !== 'generic' ? fitSubSport : null;

	if (sport === 'ride' && (fitSubSport === 'indoorCycling' || fitSubSport === 'virtualActivity')) {
		return { sport: 'virtual_ride', sub_sport: 'indoor' };
	}
	if (sport === 'ride' && fitSubSport === 'gravelCycling') return { sport: 'gravel_ride', sub_sport: sub };
	if (sport === 'ride' && fitSubSport === 'mountain') return { sport: 'mountain_bike', sub_sport: sub };
	if (sport === 'run' && fitSubSport === 'treadmill') return { sport: 'treadmill_run', sub_sport: 'indoor' };
	if (sport === 'run' && fitSubSport === 'trail') return { sport: 'trail_run', sub_sport: sub };
	if (sport === 'swim' && fitSubSport === 'openWater') return { sport: 'open_water_swim', sub_sport: 'open_water' };

	return { sport, sub_sport: sub };
}

/**
 * A bike ride with no GPS track is a trainer ride, whatever the provider
 * labelled it. `refineSport` already does this for a FIT file's own sub-sport
 * (indoorCycling/virtualActivity → virtual_ride), but a ride that arrives with
 * only Strava's plain "Ride" label — a Zwift session synced through the API, a
 * trainer ride exported to a routeless GPX — keeps `ride`, so it lands in the
 * outdoor bucket the sport filter, heatmap and card all read as a road ride.
 * Migration 0046 backfilled 168 of these; this keeps every new one correct at
 * ingest, on the same predicate the app uses (activities.ts `hasGps`: no route).
 *
 * STANDALONE ACTIVITIES ONLY. A triathlon's bike leg is not a trainer ride even
 * when its route didn't record, so the leg builders (import-strava-archive.mjs)
 * must not call this — exactly as 0046 skipped `parent_id is not null`.
 */
export function virtualizeGpslessRide(a: CanonicalActivity): CanonicalActivity {
	const roadBike = a.sport === 'ride' || a.sport === 'gravel_ride' || a.sport === 'mountain_bike';
	if (!roadBike) return a;
	const hasTrack = (a.streams?.latlng ?? []).some(
		(p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && !(p[0] === 0 && p[1] === 0),
	);
	if (hasTrack) return a;
	return { ...a, sport: 'virtual_ride', sub_sport: a.sub_sport ?? 'indoor' };
}

// ---------------------------------------------------------------------------
// Local date
// ---------------------------------------------------------------------------

/**
 * The calendar day WHERE IT HAPPENED (§5) — the column the whole week grid
 * keys off, so a 5pm Pacific ride must never land on tomorrow.
 *
 * A FIT file answers this exactly: it carries both a UTC timestamp and a
 * localTimestamp, and the difference is the offset that was in force. GPX and
 * TCX carry UTC only, so for those we fall back to this athlete's home zone at
 * that instant, which is right for everything but travel.
 *
 * ponytail: home-zone fallback for GPX/TCX. Correct offset needs the start
 * coordinate resolved to a timezone (a tz-lookup dependency and a shapefile);
 * worth it only if a trip abroad ever shows up on the wrong day. The error is
 * bounded at one day and only for activities within a few hours of midnight.
 */
export const HOME_TZ = 'America/Los_Angeles';

export function offsetMinutesInZone(instant: Date, timeZone: string): number {
	// Intl gives us the wall-clock reading in the zone; the gap between that and
	// the same fields read in UTC is the offset. No dependency, no DST table.
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	const p: Record<string, string> = {};
	for (const { type, value } of fmt.formatToParts(instant)) p[type] = value;
	const asUtc = Date.UTC(
		Number(p.year),
		Number(p.month) - 1,
		Number(p.day),
		Number(p.hour === '24' ? '00' : p.hour),
		Number(p.minute),
		Number(p.second),
	);
	return Math.round((asUtc - instant.getTime()) / 60000);
}

/** `YYYY-MM-DD` of the instant as read on a clock `offsetMinutes` east of UTC. */
export function localDate(startedAt: string, offsetMinutes: number): string {
	const shifted = new Date(new Date(startedAt).getTime() + offsetMinutes * 60000);
	return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Canonical → database rows
// ---------------------------------------------------------------------------

export interface ActivityRowSet {
	activity: Record<string, unknown>;
	streams: Record<string, unknown> | null;
	laps: Record<string, unknown>[];
}

// STREAMS ARE STORED WHOLE, at whatever rate the device recorded — a four-hour
// ride at 1 Hz keeps all 14,400 samples.
//
// An earlier version decimated them to 1500 on the way in, to hold the
// database down. That was the wrong place to spend the saving: the file is the
// primary record, an ingest-time decimation is irreversible without re-reading
// the archive, and it quietly weakens the recompute §3 promises (normalized
// power off a 12-second sampling is a smoothed NP). The rule now is that the
// database holds what the sensors saw.
//
// The detail page still must not push 14,400 points at a browser — but that is
// a RENDERING concern, decided by how wide the chart is, and it belongs to
// whatever draws it. Storage keeps the truth; display picks a resolution.
//
// The one thing trimmed on the way in is FLOAT NOISE, not samples. A device
// that knows where it is to within a few metres still emits
// `47.61234567890123`, and those trailing digits are an artifact of binary
// float conversion rather than anything the GPS measured. Every sample is kept
// at the precision its sensor actually has:

/** Decimal places per stream, at or above each sensor's real resolution.
 *  latlng at 6dp is ~11cm; altitude and distance at 0.1m; speed at 1cm/s. */
const STREAM_PRECISION: Record<string, number> = {
	altitude_m: 1,
	distance_m: 1,
	speed_ms: 2,
	grade: 2,
	temp_c: 1,
};
const LATLNG_DP = 6;

function trimFloatNoise(s: CanonicalStreams): CanonicalStreams {
	const round = (v: unknown, dp: number) =>
		typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(dp)) : v;

	const out: CanonicalStreams = { ...s };
	if (out.latlng) {
		out.latlng = out.latlng.map((p) =>
			Array.isArray(p) ? ([round(p[0], LATLNG_DP), round(p[1], LATLNG_DP)] as [number, number]) : p,
		);
	}
	for (const [key, dp] of Object.entries(STREAM_PRECISION)) {
		const arr = (out as Record<string, unknown>)[key];
		if (Array.isArray(arr)) (out as Record<string, unknown>)[key] = arr.map((v) => round(v, dp));
	}
	return out;
}

const round = (v: number | null | undefined, dp = 2): number | null =>
	v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

const int = (v: number | null | undefined): number | null =>
	v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v);

/**
 * The one place that knows what a database row looks like. Takes what a parser
 * measured plus the thresholds in force on the day, and adds the three derived
 * things: the local date, the route geometry (§7), and exertion (§3).
 */
export function toRows(a: CanonicalActivity, thresholds: Thresholds): ActivityRowSet {
	const startedAt = new Date(a.started_at);
	const offset =
		a.utc_offset_minutes ?? offsetMinutesInZone(startedAt, a.timezone ?? HOME_TZ);

	// --- geometry (§7) -----------------------------------------------------
	// A pool swim, a trainer ride and a treadmill run reach this with no latlng
	// and every geometry column stays null — a normal reading, not a gap.
	const track = (a.streams?.latlng ?? []).filter(
		(p): p is [number, number] =>
			Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && !(p[0] === 0 && p[1] === 0),
	);
	const bb = track.length ? bounds(track) : null;

	// --- exertion (§3) -----------------------------------------------------
	const exertion = computeExertion(
		{
			sport: a.sport,
			moving_seconds: a.moving_seconds ?? null,
			elapsed_seconds: a.elapsed_seconds,
			distance_m: a.distance_m ?? null,
			elevation_gain_m: a.elevation_gain_m ?? null,
			avg_hr: a.avg_hr ?? null,
			avg_power_w: a.avg_power_w ?? null,
			streams: a.streams
				? {
						time_s: a.streams.time_s,
						power_w: a.streams.power_w,
						heartrate: a.streams.heartrate,
						altitude_m: a.streams.altitude_m,
						distance_m: a.streams.distance_m,
						moving: a.streams.moving,
					}
				: undefined,
		},
		thresholds,
	);

	const hasStreams = Boolean(
		a.streams && Object.values(a.streams).some((arr) => Array.isArray(arr) && arr.length > 0),
	);

	const activity: Record<string, unknown> = {
		sport: a.sport,
		sub_sport: a.sub_sport ?? null,
		title: a.title?.trim() || defaultTitle(a),
		notes: a.notes?.trim() || null,
		private_notes: a.private_notes?.trim() || null,

		started_at: startedAt.toISOString(),
		local_date: localDate(a.started_at, offset),
		utc_offset_minutes: offset,
		timezone: a.timezone ?? null,

		elapsed_seconds: Math.round(a.elapsed_seconds),
		moving_seconds: int(a.moving_seconds),
		distance_m: round(a.distance_m, 1),
		elevation_gain_m: round(a.elevation_gain_m, 1),
		elevation_loss_m: round(a.elevation_loss_m, 1),
		elev_high_m: round(a.elev_high_m, 1),
		elev_low_m: round(a.elev_low_m, 1),

		avg_speed_ms: round(a.avg_speed_ms, 3),
		max_speed_ms: round(a.max_speed_ms, 3),
		avg_hr: int(a.avg_hr),
		max_hr: int(a.max_hr),
		avg_cadence: int(a.avg_cadence),
		avg_power_w: int(a.avg_power_w),
		max_power_w: int(a.max_power_w),
		normalized_power_w: int(a.normalized_power_w),
		work_kj: round(a.work_kj, 1),
		calories: int(a.calories),
		avg_temp_c: round(a.avg_temp_c, 1),

		pool_length_m: round(a.pool_length_m, 2),
		total_strokes: int(a.total_strokes),
		avg_swolf: int(a.avg_swolf),

		exertion: round(exertion.score, 2),
		exertion_method: exertion.method,
		exertion_confidence: exertion.confidence,
		intensity_factor: round(exertion.intensityFactor, 3),

		polyline: track.length ? encodePolyline(track) : null,
		route_path: track.length ? routePath(track) : null,
		start_lat: track.length ? round(track[0][0], 6) : null,
		start_lng: track.length ? round(track[0][1], 6) : null,
		end_lat: track.length ? round(track[track.length - 1][0], 6) : null,
		end_lng: track.length ? round(track[track.length - 1][1], 6) : null,
		bbox_w: bb ? round(bb.w, 6) : null,
		bbox_s: bb ? round(bb.s, 6) : null,
		bbox_e: bb ? round(bb.e, 6) : null,
		bbox_n: bb ? round(bb.n, 6) : null,

		has_streams: hasStreams,
		device_name: a.device_name ?? null,
	};

	const stored = hasStreams ? trimFloatNoise(a.streams as CanonicalStreams) : null;

	const streams = stored
		? {
				sample_count: streamLength(stored),
				time_s: stored.time_s ?? null,
				latlng: stored.latlng ?? null,
				altitude_m: stored.altitude_m ?? null,
				distance_m: stored.distance_m ?? null,
				heartrate: stored.heartrate ?? null,
				cadence: stored.cadence ?? null,
				power_w: stored.power_w ?? null,
				speed_ms: stored.speed_ms ?? null,
				temp_c: stored.temp_c ?? null,
				grade: stored.grade ?? null,
				moving: stored.moving ?? null,
			}
		: null;

	const laps = (a.laps ?? []).map((l) => ({
		lap_index: l.lap_index,
		name: l.name ?? null,
		start_time: l.start_time ?? null,
		elapsed_seconds: int(l.elapsed_seconds),
		moving_seconds: int(l.moving_seconds),
		distance_m: round(l.distance_m, 1),
		avg_hr: int(l.avg_hr),
		max_hr: int(l.max_hr),
		avg_power_w: int(l.avg_power_w),
		avg_speed_ms: round(l.avg_speed_ms, 3),
		elevation_gain_m: round(l.elevation_gain_m, 1),
		lap_type: l.lap_type ?? 'lap',
	}));

	return { activity, streams, laps };
}

function streamLength(s: CanonicalStreams): number {
	let n = 0;
	for (const arr of Object.values(s)) if (Array.isArray(arr)) n = Math.max(n, arr.length);
	return n;
}

/** `title` is not null in the schema, and a device file often has no name at
 *  all. "Morning Ride" is Strava's own convention and reads better than the
 *  slug alone. */
function defaultTitle(a: CanonicalActivity): string {
	const label = SPORT_META[a.sport].label;
	const hour = new Date(a.started_at).getUTCHours() + (a.utc_offset_minutes ?? 0) / 60;
	const h = ((hour % 24) + 24) % 24;
	const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
	return `${part} ${label}`;
}
