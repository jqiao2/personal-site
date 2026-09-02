// Service layer for the activity log — the fourth section, and the first
// whose records are ingested rather than typed. Reads go through the anon
// client (the tables are publicly readable, RLS enabled, like the film and
// restaurant logs); the writes here (updateActivity/deleteActivity) go through
// the service-role client and are only ever called after requireOwner() at the
// API-route/page layer, same convention as films.ts's writes.
//
// Schema: supabase/migrations/0034_activity_log.sql. Design contract:
// ACTIVITIES.md §5 (schema), §6 (sports.ts is imported from, not duplicated —
// sportMeta() is the one place a sport's family is decided) and §8 (filters
// and sorts, mirrored here as ActivityQuery/ACTIVITY_SORTS the way
// WatchedQuery/isWatchedSort work in films.ts).
import { supabaseAdmin, supabasePublic } from './supabase';
import { siteYear } from './day';
import { sportMeta, type SportFamily } from './sports';
import { decodePolyline, encodePolyline, mercator, simplify, splitOnGaps } from './route-shape';

// ---------------------------------------------------------------------------
// Migration-tier degradation — mirrors films.ts's isMissingCreditColumn /
// isMissingRelation. This section's whole schema lands in one migration
// (0034), so these mostly guard a *later* migration (e.g. a 0035 adding a
// column) that hasn't been applied yet in some environment — the reads below
// step down to an empty/null result instead of a 500.
// ---------------------------------------------------------------------------
function isMissingColumn(err: { code?: string; message?: string } | null): boolean {
	if (!err) return false;
	const msg = (err.message ?? '').toLowerCase();
	return (
		err.code === '42703' || // undefined_column
		err.code === 'PGRST204' || // column not found in schema cache
		(msg.includes('column') && msg.includes('does not exist')) ||
		msg.includes('schema cache')
	);
}

function isMissingRelation(err: { code?: string; message?: string } | null): boolean {
	if (!err) return false;
	const msg = (err.message ?? '').toLowerCase();
	return (
		err.code === '42P01' || // undefined_table
		err.code === 'PGRST200' || // no such relationship in the schema cache
		msg.includes('does not exist') ||
		msg.includes('schema cache')
	);
}

function isDegraded(err: { code?: string; message?: string } | null): boolean {
	return isMissingColumn(err) || isMissingRelation(err);
}

// ---------------------------------------------------------------------------
// Row shapes — one-for-one with the SQL columns (snake_case, as PostgREST
// returns them). Kept flat rather than nested; the pages reshape as needed.
// ---------------------------------------------------------------------------

import { redactActivities } from './activity-privacy';
import type { SkiSegmentOverride } from './ski';
import { computeExertion, type Thresholds } from './exertion';

/** All-null thresholds — the score for a ski day with no strap doesn't need
 *  any, and `saveSkiSegments` must still work before the athlete has recorded
 *  one for the date. */
const EMPTY_THRESHOLDS: Thresholds = {
	ftp_w: null,
	lthr_bpm: null,
	max_hr: null,
	rest_hr: null,
	threshold_pace_s_per_km: null,
	css_pace_s_per_100m: null,
	weight_kg: null,
};
export { redactActivities };

// Mirrors exertion.ts's ExertionMethod — 'ski' is the lift-served ski rung
// (migration 0050). Kept as a local copy so this file's row types don't depend
// on importing the calculator, but it must stay in step with it.
export type ExertionMethod = 'tss' | 'hrtss' | 'avghr' | 'ptss' | 'met' | 'ski';
export type ExertionConfidence = 'measured' | 'estimated' | 'assumed';
export type LapType = 'lap' | 'interval' | 'rest' | 'transition' | 'length';
export type GearKind = 'bike' | 'shoes' | 'skis' | 'board' | 'other';

/** The full `activities` row — the detail page's read model. */
export interface ActivityRow {
	id: number;
	sport: string;
	sub_sport: string | null;
	parent_id: number | null;
	leg: number | null;
	title: string;
	notes: string | null;
	/** Free-text tags, applied by hand after ingest. `[]` when none. */
	tags: string[];
	/**
	 * Always null here. `private_notes` is "never rendered publicly" per the
	 * schema comment, and the strongest place to hold that line is the data
	 * layer rather than trusting every future template to remember to omit
	 * it — getActivity() never selects the column over the public (anon-key)
	 * client. There's no owner-side editor built in this track to need the
	 * real value; when one exists, it should read the column directly via
	 * supabaseAdmin rather than through this function.
	 */
	private_notes: string | null;
	/** Owner-only when true — the default for every activity (migration 0043).
	 * Read `false` as "deliberately published", and read a missing column (an
	 * environment behind on migrations) as private: this is the one field where
	 * the safe reading of "I don't know" is the restrictive one. */
	private: boolean;
	/** Owner's choice to keep this activity off /month (migration 0044).
	 * Presentation only — /month is owner-gated either way, so unlike
	 * `private` a missing column reads as `false` (show it). */
	hide_from_review: boolean;
	started_at: string;
	local_date: string;
	utc_offset_minutes: number | null;
	timezone: string | null;
	elapsed_seconds: number;
	moving_seconds: number | null;
	distance_m: number | null;
	elevation_gain_m: number | null;
	elevation_loss_m: number | null;
	elev_high_m: number | null;
	elev_low_m: number | null;
	avg_speed_ms: number | null;
	max_speed_ms: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	avg_cadence: number | null;
	avg_power_w: number | null;
	max_power_w: number | null;
	normalized_power_w: number | null;
	work_kj: number | null;
	calories: number | null;
	avg_temp_c: number | null;
	pool_length_m: number | null;
	total_strokes: number | null;
	avg_swolf: number | null;
	exertion: number | null;
	exertion_method: ExertionMethod | null;
	exertion_confidence: ExertionConfidence | null;
	intensity_factor: number | null;
	polyline: string | null;
	route_path: string | null;
	start_lat: number | null;
	start_lng: number | null;
	end_lat: number | null;
	end_lng: number | null;
	bbox_w: number | null;
	bbox_s: number | null;
	bbox_e: number | null;
	bbox_n: number | null;
	start_place: string | null;
	gear_id: number | null;
	has_streams: boolean;
	device_name: string | null;
	created_at: string;
	updated_at: string;
	/** Owner-corrected run/lift partition for a ski day (migration 0051), or null
	 * to use auto-detection. Detail page only — the list view doesn't carry it. */
	ski_segments: SkiSegmentOverride[] | null;
}

/** A row of the `activity_list` view — everything the list/landing pages need
 * and nothing they don't (no streams, no raw source payloads). */
export interface ActivityListRow {
	id: number;
	sport: string;
	sub_sport: string | null;
	parent_id: number | null;
	leg: number | null;
	title: string;
	notes: string | null;
	started_at: string;
	local_date: string;
	utc_offset_minutes: number | null;
	timezone: string | null;
	elapsed_seconds: number;
	moving_seconds: number | null;
	distance_m: number | null;
	elevation_gain_m: number | null;
	elevation_loss_m: number | null;
	elev_high_m: number | null;
	elev_low_m: number | null;
	avg_speed_ms: number | null;
	max_speed_ms: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	avg_cadence: number | null;
	avg_power_w: number | null;
	max_power_w: number | null;
	normalized_power_w: number | null;
	work_kj: number | null;
	calories: number | null;
	avg_temp_c: number | null;
	pool_length_m: number | null;
	total_strokes: number | null;
	avg_swolf: number | null;
	exertion: number | null;
	exertion_method: ExertionMethod | null;
	exertion_confidence: ExertionConfidence | null;
	intensity_factor: number | null;
	polyline: string | null;
	route_path: string | null;
	start_lat: number | null;
	start_lng: number | null;
	end_lat: number | null;
	end_lng: number | null;
	bbox_w: number | null;
	bbox_s: number | null;
	bbox_e: number | null;
	bbox_n: number | null;
	start_place: string | null;
	gear_id: number | null;
	gear_name: string | null;
	gear_nickname: string | null;
	has_streams: boolean;
	device_name: string | null;
	created_at: string;
	updated_at: string;
	/** The winning (highest-fidelity) source's provider, e.g. 'strava_archive'.
	 * Null for an activity with no recorded source (a bare manual entry). */
	source_provider: string | null;
	/** See ActivityRow.private. */
	private: boolean;
	/** Owner's choice to keep this activity off /month (migration 0044).
	 * Presentation only — /month is owner-gated either way, so unlike
	 * `private` a missing column reads as `false` (show it). */
	hide_from_review: boolean;
	/** Set by `redactActivities` on a private row a visitor is being shown:
	 * everything but the sport and the day has been stripped. Never set on a
	 * row the owner is looking at, and never a database column. */
	redacted?: boolean;
}

/** The `activity_streams` row for one activity — big arrays, detail page only. */
export interface ActivityStreams {
	activity_id: number;
	sample_count: number;
	time_s: number[] | null;
	latlng: [number, number][] | null;
	altitude_m: number[] | null;
	distance_m: number[] | null;
	heartrate: number[] | null;
	cadence: number[] | null;
	power_w: number[] | null;
	speed_ms: number[] | null;
	temp_c: number[] | null;
	grade: number[] | null;
	moving: boolean[] | null;
}

export interface ActivityLap {
	id: number;
	activity_id: number;
	lap_index: number;
	name: string | null;
	start_time: string | null;
	elapsed_seconds: number | null;
	moving_seconds: number | null;
	distance_m: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	avg_power_w: number | null;
	avg_speed_ms: number | null;
	elevation_gain_m: number | null;
	lap_type: LapType;
}

export interface ActivityGear {
	id: number;
	kind: GearKind;
	name: string;
	brand: string | null;
	model: string | null;
	nickname: string | null;
	retired_at: string | null;
	distance_m: number;
	external_ids: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface AthleteThresholds {
	id: number;
	effective_from: string;
	ftp_w: number | null;
	lthr_bpm: number | null;
	max_hr: number | null;
	rest_hr: number | null;
	threshold_pace_s_per_km: number | null;
	css_pace_s_per_100m: number | null;
	weight_kg: number | null;
	created_at: string;
}

/** A row of the `activity_days` view — one calendar day's rollup. */
export interface ActivityDay {
	local_date: string;
	activity_count: number;
	total_distance_m: number;
	total_elevation_gain_m: number;
	total_moving_seconds: number;
	total_exertion: number;
	sports: string[];
}

/** A row of the `activity_months` view — one calendar month's rollup. */
export interface ActivityMonth {
	month_key: string;
	activity_count: number;
	total_distance_m: number;
	total_elevation_gain_m: number;
	total_moving_seconds: number;
	total_exertion: number;
	sports: string[];
}

// ---------------------------------------------------------------------------
// listActivities — /activities/all. Every filter and sort in ACTIVITIES.md §8.
// ---------------------------------------------------------------------------

/** Sorts /activities/all offers. All but 'date' default to descending — the
 * point of sorting by exertion/distance/etc is almost always "show me the
 * biggest ones first". */
export type ActivitySort =
	| 'date'
	| 'exertion'
	| 'distance'
	| 'duration'
	| 'elevation'
	| 'pace'
	| 'power'
	| 'hr'
	| 'calories';

export const ACTIVITY_SORTS: readonly ActivitySort[] = [
	'date',
	'exertion',
	'distance',
	'duration',
	'elevation',
	'pace',
	'power',
	'hr',
	'calories',
];

/** Whether a sort name is one we support; anything else falls back to 'date'. */
export function isActivitySort(v: unknown): v is ActivitySort {
	return typeof v === 'string' && (ACTIVITY_SORTS as readonly string[]).includes(v);
}

/** Which slice of the activity collection to read — src/lib/activity-params.ts
 * parses the query string into this shape for both the server-rendered first
 * page and the batches paged in afterwards, the same split films.ts uses for
 * WatchedQuery. */
export interface ActivityQuery {
	sort?: ActivitySort;
	/** 'date' defaults to newest first; every other sort defaults to biggest
	 * first. Set 'asc' to flip either. */
	sortDir?: 'asc' | 'desc';
	limit?: number;
	offset?: number;

	/** Canonical sport slugs (src/lib/sports.ts), OR'd together. */
	sports?: string[];
	/** Inclusive local_date bounds, "YYYY-MM-DD". */
	dateFrom?: string;
	dateTo?: string;
	distanceMinM?: number;
	distanceMaxM?: number;
	/** Moving-time bounds, in seconds — the same clock exertion is computed
	 * against (ACTIVITIES.md §3: "Exertion always uses moving time"). */
	durationMinS?: number;
	durationMaxS?: number;
	elevationMinM?: number;
	elevationMaxM?: number;
	exertionMin?: number;
	exertionMax?: number;
	/** Only activities with a route to draw (route_path is not null). */
	hasGps?: boolean;
	gearIds?: number[];
	/** true = indoor only, false = outdoor only, omit = either.
	 * "Indoor" is sub_sport = 'indoor' OR sport in (virtual_ride, treadmill_run)
	 * — there's no first-class indoor/outdoor column, so this is a heuristic
	 * over the two places that fact actually shows up. */
	indoor?: boolean;
	hasPower?: boolean;
	hasHr?: boolean;
	/** Case-insensitive substring against start_place. */
	place?: string;
	/**
	 * "Personal best" has no dedicated column in the schema (ACTIVITIES.md §8
	 * names the filter but §5's schema has no PR flag) — a real PR detector
	 * belongs to the ingest/exertion tracks, which own the streams. This is a
	 * defensible stand-in until that exists: an activity is a "PR" here if it
	 * is the longest, all-time, standalone activity for its sport. Documented
	 * as a deviation in the schema-track report.
	 */
	personalBestOnly?: boolean;
	/** Include multisport child legs (swim/T1/bike/T2/run) as their own rows.
	 * Off by default — a triathlon shows as its one parent row, the way
	 * activity_days and activity_months already roll it up. */
	includeChildren?: boolean;
}

const DEFAULT_LIST_LIMIT = 50;

/** The all-time longest standalone activity per sport — see personalBestOnly's
 * doc comment for why this heuristic exists. Paged past PostgREST's 1000-row
 * cap the way films.ts's countWatchesByMonth is, since the whole table is read. */
async function personalBestIds(): Promise<Set<number>> {
	const PAGE = 1000;
	const bestBySport = new Map<string, { id: number; distance: number }>();
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('activity_list')
			.select('id, sport, distance_m')
			.is('parent_id', null)
			.not('distance_m', 'is', null)
			.range(offset, offset + PAGE - 1);
		if (error) {
			if (isDegraded(error)) return new Set();
			throw new Error(`personalBestIds failed: ${error.message}`);
		}
		const rows = (data ?? []) as { id: number; sport: string; distance_m: number }[];
		for (const row of rows) {
			const best = bestBySport.get(row.sport);
			if (!best || row.distance_m > best.distance) {
				bestBySport.set(row.sport, { id: row.id, distance: row.distance_m });
			}
		}
		if (rows.length < PAGE) break;
	}
	return new Set([...bestBySport.values()].map((b) => b.id));
}

/** The column each sort reads, for both the ORDER BY and the ascending default. */
const SORT_COLUMN: Record<ActivitySort, string> = {
	date: 'local_date',
	exertion: 'exertion',
	distance: 'distance_m',
	duration: 'moving_seconds',
	elevation: 'elevation_gain_m',
	pace: 'avg_speed_ms',
	power: 'avg_power_w',
	hr: 'avg_hr',
	calories: 'calories',
};

/**
 * The reverse-chronological, filterable, sortable list behind /activities/all
 * (and the API route it shares a parser with). Reads the activity_list view,
 * so streams/raw sources never enter the query.
 */
export async function listActivities(
	query: ActivityQuery = {},
	isOwner = false,
): Promise<{ rows: ActivityListRow[]; total: number }> {
	const { sort = 'date', limit = DEFAULT_LIST_LIMIT, offset = 0 } = query;
	const ascending = query.sortDir ? query.sortDir === 'asc' : sort === 'date' ? false : false;
	// (sort === 'date' also defaults to descending — spelled out so the intent
	// reads plainly rather than relying on the ternary collapsing to the same
	// value both ways.)

	const prIds = query.personalBestOnly ? await personalBestIds() : null;
	if (prIds && prIds.size === 0) return { rows: [], total: 0 };

	let req = supabasePublic.from('activity_list').select('*', { count: 'exact' });

	if (!query.includeChildren) req = req.is('parent_id', null);
	if (prIds) req = req.in('id', [...prIds]);

	if (query.sports?.length) req = req.in('sport', query.sports);
	if (query.dateFrom) req = req.gte('local_date', query.dateFrom);
	if (query.dateTo) req = req.lte('local_date', query.dateTo);
	if (query.distanceMinM != null) req = req.gte('distance_m', query.distanceMinM);
	if (query.distanceMaxM != null) req = req.lte('distance_m', query.distanceMaxM);
	if (query.durationMinS != null) req = req.gte('moving_seconds', query.durationMinS);
	if (query.durationMaxS != null) req = req.lte('moving_seconds', query.durationMaxS);
	if (query.elevationMinM != null) req = req.gte('elevation_gain_m', query.elevationMinM);
	if (query.elevationMaxM != null) req = req.lte('elevation_gain_m', query.elevationMaxM);
	if (query.exertionMin != null) req = req.gte('exertion', query.exertionMin);
	if (query.exertionMax != null) req = req.lte('exertion', query.exertionMax);

	if (query.hasGps === true) req = req.not('route_path', 'is', null);
	if (query.hasGps === false) req = req.is('route_path', null);

	if (query.gearIds?.length) req = req.in('gear_id', query.gearIds);

	if (query.indoor === true) {
		req = req.or('sub_sport.eq.indoor,sport.in.(virtual_ride,treadmill_run)');
	} else if (query.indoor === false) {
		req = req.not('sub_sport', 'eq', 'indoor').not('sport', 'in', '(virtual_ride,treadmill_run)');
	}

	if (query.hasPower) req = req.not('avg_power_w', 'is', null);
	if (query.hasHr) req = req.not('avg_hr', 'is', null);

	const place = query.place?.trim();
	if (place) req = req.ilike('start_place', `%${place.replace(/[%_]/g, '\\$&')}%`);

	req = req.order(SORT_COLUMN[sort], { ascending, nullsFirst: false });
	// Tiebreak for a deterministic order (matters for paging): newest id last
	// unless we're already sorting by date, in which case id order and date
	// order agree closely enough that a second date-adjacent key would be
	// redundant.
	if (sort !== 'date') req = req.order('local_date', { ascending: false, nullsFirst: false });
	req = req.order('id', { ascending: false });

	const { data, error, count } = await req.range(offset, offset + limit - 1);
	if (error) {
		if (isDegraded(error)) return { rows: [], total: 0 };
		throw new Error(`listActivities failed: ${error.message}`);
	}
	return { rows: redactActivities((data ?? []) as ActivityListRow[], isOwner), total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// listActivityDays — the landing page's week grid.
// ---------------------------------------------------------------------------

export interface ActivityDayWithActivities extends ActivityDay {
	/** That day's top-level activities (multisport legs folded under their
	 * parent), oldest first — the order a vertical day list reads naturally. */
	activities: ActivityListRow[];
}

/**
 * Days with at least one activity, newest first, each carrying its own
 * activities — the read model for the landing page's reverse-chronological
 * week calendar. `before` pages backward (strictly older than that date) so
 * the grid can load more weeks on scroll without re-fetching what's shown.
 */
export async function listActivityDays(
	opts: { limit?: number; before?: string; isOwner?: boolean } = {},
): Promise<ActivityDayWithActivities[]> {
	const limit = opts.limit ?? 14;

	let dayReq = supabasePublic
		.from('activity_days')
		.select('*')
		.order('local_date', { ascending: false })
		.limit(limit);
	if (opts.before) dayReq = dayReq.lt('local_date', opts.before);

	const { data: days, error: dayErr } = await dayReq;
	if (dayErr) {
		if (isDegraded(dayErr)) return [];
		throw new Error(`listActivityDays failed: ${dayErr.message}`);
	}
	const dayRows = (days ?? []) as ActivityDay[];
	if (dayRows.length === 0) return [];

	const dates = dayRows.map((d) => d.local_date);
	const { data: activities, error: actErr } = await supabasePublic
		.from('activity_list')
		.select('*')
		.in('local_date', dates)
		.is('parent_id', null)
		.order('started_at', { ascending: true });
	if (actErr) {
		if (isDegraded(actErr)) return dayRows.map((d) => ({ ...d, activities: [] }));
		throw new Error(`listActivityDays (activities) failed: ${actErr.message}`);
	}

	const byDate = new Map<string, ActivityListRow[]>();
	for (const row of redactActivities((activities ?? []) as ActivityListRow[], opts.isOwner ?? false)) {
		const list = byDate.get(row.local_date);
		if (list) list.push(row);
		else byDate.set(row.local_date, [row]);
	}
	return dayRows.map((d) => ({ ...d, activities: byDate.get(d.local_date) ?? [] }));
}

// ---------------------------------------------------------------------------
// Single-activity reads — the detail page.
// ---------------------------------------------------------------------------

/** Every column except `private_notes` — see ActivityRow.private_notes for why. */
const PUBLIC_ACTIVITY_COLUMNS = [
	'id',
	'sport',
	'sub_sport',
	'parent_id',
	'leg',
	'title',
	'notes',
	'tags',
	'started_at',
	'local_date',
	'utc_offset_minutes',
	'timezone',
	'elapsed_seconds',
	'moving_seconds',
	'distance_m',
	'elevation_gain_m',
	'elevation_loss_m',
	'elev_high_m',
	'elev_low_m',
	'avg_speed_ms',
	'max_speed_ms',
	'avg_hr',
	'max_hr',
	'avg_cadence',
	'avg_power_w',
	'max_power_w',
	'normalized_power_w',
	'work_kj',
	'calories',
	'avg_temp_c',
	'pool_length_m',
	'total_strokes',
	'avg_swolf',
	'exertion',
	'exertion_method',
	'exertion_confidence',
	'intensity_factor',
	'polyline',
	'route_path',
	'start_lat',
	'start_lng',
	'end_lat',
	'end_lng',
	'bbox_w',
	'bbox_s',
	'bbox_e',
	'bbox_n',
	'start_place',
	'gear_id',
	'has_streams',
	'device_name',
	'created_at',
	'updated_at',
	'private',
	'hide_from_review',
	'ski_segments',
].join(', ');

/** One activity by id, in full (bar `private_notes` — always null; see
 * ActivityRow). Null if it doesn't exist or is soft-deleted. */
export async function getActivity(id: number): Promise<ActivityRow | null> {
	// `tags` (0035), `private` (0043) and `hide_from_review` (0044) arrive in
	// later migrations than the rest of the schema, so an environment behind on
	// any of them gets the activity without them rather than a 404 for every
	// activity on the site. Each step drops one more, newest first.
	const noSki = PUBLIC_ACTIVITY_COLUMNS.replace(', ski_segments', '');
	const attempts = [
		PUBLIC_ACTIVITY_COLUMNS,
		noSki,
		noSki.replace(', hide_from_review', ''),
		noSki.replace(', hide_from_review', '').replace(', private', ''),
		noSki.replace(', hide_from_review', '').replace(', private', '').replace(', tags', ''),
	];
	for (const [i, columns] of attempts.entries()) {
		const { data, error } = await supabasePublic
			.from('activities')
			.select(columns)
			.eq('id', id)
			.is('deleted_at', null)
			.maybeSingle();
		if (error) {
			// Keep dropping columns while there's a shorter select left to try.
			// (This used to compare against the first entry, which made every
			// step after the second unreachable.)
			if (isMissingColumn(error) && i < attempts.length - 1) continue;
			if (isDegraded(error)) return null;
			throw new Error(`getActivity failed: ${error.message}`);
		}
		if (!data) return null;
		// The three late columns may be absent (the fallback selects above), so
		// they're defaulted rather than spread over. `private` defaults the
		// restrictive way — anything but an explicit false is private — while
		// `hide_from_review` defaults to showing, since it guards nothing.
		const row = data as unknown as Omit<
			ActivityRow,
			'private_notes' | 'tags' | 'private' | 'hide_from_review' | 'ski_segments'
		> & {
			tags?: string[];
			private?: boolean;
			hide_from_review?: boolean;
			ski_segments?: SkiSegmentOverride[] | null;
		};
		return {
			...row,
			tags: row.tags ?? [],
			private: row.private !== false,
			hide_from_review: row.hide_from_review === true,
			ski_segments: row.ski_segments ?? null,
			private_notes: null,
		};
	}
	return null;
}

/** The 1Hz-ish sample streams for one activity. Null when the activity has
 * none (no device data, or a GPS-less indoor session with no streams at all). */
export async function getActivityStreams(id: number): Promise<ActivityStreams | null> {
	const { data, error } = await supabasePublic
		.from('activity_streams')
		.select('*')
		.eq('activity_id', id)
		.maybeSingle();
	if (error) {
		if (isDegraded(error)) return null;
		throw new Error(`getActivityStreams failed: ${error.message}`);
	}
	return (data as ActivityStreams | null) ?? null;
}

/** An activity's laps, in order. [] for an activity with none. */
export async function listActivityLaps(id: number): Promise<ActivityLap[]> {
	const { data, error } = await supabasePublic
		.from('activity_laps')
		.select('*')
		.eq('activity_id', id)
		.order('lap_index', { ascending: true });
	if (error) {
		if (isDegraded(error)) return [];
		throw new Error(`listActivityLaps failed: ${error.message}`);
	}
	return (data ?? []) as ActivityLap[];
}

/** A multisport parent's child legs (swim/T1/bike/T2/run…), in leg order.
 * [] for a standalone activity. */
export async function listActivityChildren(parentId: number, isOwner = false): Promise<ActivityListRow[]> {
	const { data, error } = await supabasePublic
		.from('activity_list')
		.select('*')
		.eq('parent_id', parentId)
		.order('leg', { ascending: true, nullsFirst: false });
	if (error) {
		if (isDegraded(error)) return [];
		throw new Error(`listActivityChildren failed: ${error.message}`);
	}
	return redactActivities((data ?? []) as ActivityListRow[], isOwner);
}

// ---------------------------------------------------------------------------
// listActivitiesForMonth — /activities/month/[month].
// ---------------------------------------------------------------------------

/** The first day of the month after "YYYY-MM", as "YYYY-MM-DD" — a small local
 * version of month-view.ts's shiftMonth rather than importing that file,
 * which belongs to the Month track and pulls in its share-card geometry. */
function firstOfNextMonth(monthKey: string): string {
	const [y, m] = monthKey.split('-').map(Number);
	const nextY = m === 12 ? y + 1 : y;
	const nextM = m === 12 ? 1 : m + 1;
	return `${nextY}-${String(nextM).padStart(2, '0')}-01`;
}

/**
 * Every top-level activity in one "YYYY-MM" month, oldest first — the read
 * model for the month-in-review page. Multisport legs are excluded (parent_id
 * is null) for the same reason activity_months rolls them up under the
 * parent: a triathlon is one entry in the month, not three.
 */
export async function listActivitiesForMonth(monthKey: string, isOwner = false): Promise<ActivityListRow[]> {
	const { data, error } = await supabasePublic
		.from('activity_list')
		.select('*')
		.gte('local_date', `${monthKey}-01`)
		.lt('local_date', firstOfNextMonth(monthKey))
		.is('parent_id', null)
		.order('started_at', { ascending: true });
	if (error) {
		if (isDegraded(error)) return [];
		throw new Error(`listActivitiesForMonth failed: ${error.message}`);
	}
	return redactActivities((data ?? []) as ActivityListRow[], isOwner);
}

// ---------------------------------------------------------------------------
// getActivityStats — the landing page's sidebar totals.
// ---------------------------------------------------------------------------

export interface ActivityStats {
	/** Top-level activities logged in the current calendar year (siteYear). */
	activitiesThisYear: number;
	/** All-time. */
	totalDistanceM: number;
	totalElevationGainM: number;
	totalMovingHours: number;
	totalExertion: number;
	/** All-time count, keyed by src/lib/sports.ts's SportFamily. Only families
	 * with at least one activity are present. */
	bySportFamily: Partial<Record<SportFamily, number>>;
}

/** The zeroed stats — what a visitor gets, and what a database that can't
 * answer gets. */
const EMPTY_ACTIVITY_STATS: ActivityStats = {
	activitiesThisYear: 0,
	totalDistanceM: 0,
	totalElevationGainM: 0,
	totalMovingHours: 0,
	totalExertion: 0,
	bySportFamily: {},
};

/**
 * Sidebar totals for the /activities landing page: this-year count alongside
 * all-time distance/elevation/moving-time/exertion and a by-family breakdown
 * — the same "one this-year callout beside the lifetime numbers" shape as
 * films.ts's FilmLogStats. Reads activity_list a page at a time (paged past
 * PostgREST's 1000-row cap, as films.ts's countWatchesByMonth does) and folds
 * in JS rather than five separate aggregate round-trips, since every number
 * needs the same row set (top-level, non-deleted activities).
 */
export async function getActivityStats(isOwner = false): Promise<ActivityStats> {
	// Every total here is a sum over private rows, so to a visitor it is the
	// same disclosure the cards were making, only pre-added: lifetime mileage,
	// hours out of the house, a fitness curve. There is no public-only version
	// of these worth computing — with `private` defaulting to true the answer
	// would be zeros anyway — so a visitor gets the empty stats and the pages
	// that draw them leave the space out entirely.
	if (!isOwner) return EMPTY_ACTIVITY_STATS;
	const year = siteYear();
	const PAGE = 1000;
	let activitiesThisYear = 0;
	let totalDistanceM = 0;
	let totalElevationGainM = 0;
	let totalMovingSeconds = 0;
	let totalExertion = 0;
	const bySportFamily = new Map<SportFamily, number>();

	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('activity_list')
			.select('sport, local_date, distance_m, elevation_gain_m, moving_seconds, exertion')
			.is('parent_id', null)
			.range(offset, offset + PAGE - 1);
		if (error) {
			if (isDegraded(error)) return EMPTY_ACTIVITY_STATS;
			throw new Error(`getActivityStats failed: ${error.message}`);
		}
		const rows = (data ?? []) as {
			sport: string;
			local_date: string;
			distance_m: number | null;
			elevation_gain_m: number | null;
			moving_seconds: number | null;
			exertion: number | null;
		}[];
		for (const row of rows) {
			if (row.local_date >= `${year}-01-01`) activitiesThisYear++;
			totalDistanceM += row.distance_m ?? 0;
			totalElevationGainM += row.elevation_gain_m ?? 0;
			totalMovingSeconds += row.moving_seconds ?? 0;
			totalExertion += row.exertion ?? 0;
			const family = sportMeta(row.sport).family;
			bySportFamily.set(family, (bySportFamily.get(family) ?? 0) + 1);
		}
		if (rows.length < PAGE) break;
	}

	return {
		activitiesThisYear,
		totalDistanceM,
		totalElevationGainM,
		totalMovingHours: totalMovingSeconds / 3600,
		totalExertion,
		bySportFamily: Object.fromEntries(bySportFamily) as Partial<Record<SportFamily, number>>,
	};
}

// ---------------------------------------------------------------------------
// thresholdsOn — the exertion calculator's input for a given date.
// ---------------------------------------------------------------------------

/** The athlete_thresholds row in force on `date` — the latest one with
 * effective_from <= date. Null if the table is empty or every row is later
 * than `date` (nothing was in force yet). */
export async function thresholdsOn(date: string): Promise<AthleteThresholds | null> {
	const { data, error } = await supabasePublic
		.from('athlete_thresholds')
		.select('*')
		.lte('effective_from', date)
		.order('effective_from', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) {
		if (isDegraded(error)) return null;
		throw new Error(`thresholdsOn failed: ${error.message}`);
	}
	return (data as AthleteThresholds | null) ?? null;
}

// ---------------------------------------------------------------------------
// Gear + facets — the filter panel on /activities/all.
// ---------------------------------------------------------------------------

/** All gear, active first (retired_at null), then by kind/name. */
export async function listGear(): Promise<ActivityGear[]> {
	const { data, error } = await supabasePublic
		.from('activity_gear')
		.select('*')
		.order('retired_at', { ascending: true, nullsFirst: true })
		.order('kind', { ascending: true })
		.order('name', { ascending: true });
	if (error) {
		if (isDegraded(error)) return [];
		throw new Error(`listGear failed: ${error.message}`);
	}
	return (data ?? []) as ActivityGear[];
}

export interface ActivityFacets {
	sports: { sport: string; count: number }[];
	gear: { gear_id: number; name: string; count: number }[];
	places: { place: string; count: number }[];
}

/**
 * Distinct sports / gear / start places with counts, for the filter panel.
 * PostgREST has no server-side GROUP BY over a view, so this pages the (small,
 * top-level) activity set once and folds the three facets in JS together —
 * one read instead of three.
 */
export async function listActivityFacets(isOwner = false): Promise<ActivityFacets> {
	// The facets are a description of the private rows — every gear nickname,
	// every start place, every sport count. A visitor gets none of them, which
	// also means the filter panel they feed draws itself empty.
	if (!isOwner) return { sports: [], gear: [], places: [] };
	const PAGE = 1000;
	const sportCounts = new Map<string, number>();
	const gearCounts = new Map<number, { name: string; count: number }>();
	const placeCounts = new Map<string, number>();

	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabasePublic
			.from('activity_list')
			.select('sport, gear_id, gear_name, gear_nickname, start_place')
			.is('parent_id', null)
			.range(offset, offset + PAGE - 1);
		if (error) {
			if (isDegraded(error)) return { sports: [], gear: [], places: [] };
			throw new Error(`listActivityFacets failed: ${error.message}`);
		}
		const rows = (data ?? []) as {
			sport: string;
			gear_id: number | null;
			gear_name: string | null;
			gear_nickname: string | null;
			start_place: string | null;
		}[];
		for (const row of rows) {
			sportCounts.set(row.sport, (sportCounts.get(row.sport) ?? 0) + 1);
			if (row.gear_id != null) {
				const label = row.gear_nickname || row.gear_name || `gear ${row.gear_id}`;
				const existing = gearCounts.get(row.gear_id);
				gearCounts.set(row.gear_id, { name: label, count: (existing?.count ?? 0) + 1 });
			}
			if (row.start_place) placeCounts.set(row.start_place, (placeCounts.get(row.start_place) ?? 0) + 1);
		}
		if (rows.length < PAGE) break;
	}

	return {
		sports: [...sportCounts.entries()]
			.map(([sport, count]) => ({ sport, count }))
			.sort((a, b) => b.count - a.count),
		gear: [...gearCounts.entries()]
			.map(([gear_id, v]) => ({ gear_id, name: v.name, count: v.count }))
			.sort((a, b) => b.count - a.count),
		places: [...placeCounts.entries()]
			.map(([place, count]) => ({ place, count }))
			.sort((a, b) => b.count - a.count),
	};
}

// ---------------------------------------------------------------------------
// Writes (owner only — the caller checks requireOwner() first, same
// convention as films.ts's and restaurants.ts's writes).
// ---------------------------------------------------------------------------

/** The fields the owner's edit state can change. Absent key = leave alone. */
export interface UpdateActivityInput {
	title?: string;
	notes?: string | null;
	sport?: string;
	gearId?: number | null;
	tags?: string[];
	/** The one switch that decides whether anyone but the owner sees any of the
	 * above. See migration 0043 and `redactActivities`. */
	private?: boolean;
	/** Keep this activity off /month. Presentation only — see migration 0044. */
	hideFromReview?: boolean;
}

/**
 * Edit an activity's authored fields — the ones a human decides rather than a
 * device records. Nothing measured is editable here: a title is a caption, a
 * distance is evidence, and letting the second be typed over would make every
 * number on the site a claim rather than a reading.
 *
 * GEAR MOVES ITS MILEAGE WITH IT. `activity_gear.distance_m` is a
 * denormalised total "kept in sync by the app on write" (0034), so re-gearing
 * a ride subtracts its distance from the old bike and adds it to the new one.
 * Without that the sidebar total drifts every time a mis-tagged ride is
 * fixed — silently, and in the direction of over-counting.
 */
export async function updateActivity(id: number, input: UpdateActivityInput): Promise<boolean> {
	const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
	if (input.title !== undefined) {
		const title = input.title.trim();
		if (!title) throw new Error('title cannot be empty');
		patch.title = title;
	}
	if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
	if (input.sport !== undefined) patch.sport = input.sport;
	if (input.gearId !== undefined) patch.gear_id = input.gearId;
	if (input.tags !== undefined) patch.tags = input.tags;
	if (input.private !== undefined) patch.private = input.private;
	if (input.hideFromReview !== undefined) patch.hide_from_review = input.hideFromReview;

	const current = await getActivity(id);
	if (!current) return false;

	const { error } = await supabaseAdmin.from('activities').update(patch).eq('id', id).is('deleted_at', null);
	if (error) throw new Error(`updateActivity failed: ${error.message}`);

	if (input.gearId !== undefined && input.gearId !== current.gear_id) {
		await moveGearDistance(current.gear_id, input.gearId, current.distance_m ?? 0);
	}
	return true;
}

/**
 * Save a hand-corrected run/lift partition for a ski day, and re-score the
 * activity on it. Unlike `updateActivity`'s authored fields, this DOES change a
 * measured number — exertion — because the correction is exactly what the score
 * should have been measuring: a lift the owner actually hiked is real descent.
 * The recompute goes through the same `computeExertion` cascade as ingest, just
 * handed the override, so the stored score, method and confidence stay the ones
 * every list and card reads. Pass `null` to clear the override and fall back to
 * auto-detection (the score reverts with it).
 */
export async function saveSkiSegments(id: number, override: SkiSegmentOverride[] | null): Promise<boolean> {
	const activity = await getActivity(id);
	if (!activity) return false;

	const [streams, thresholds] = await Promise.all([getActivityStreams(id), thresholdsOn(activity.local_date)]);
	const ex = computeExertion(
		{
			sport: activity.sport,
			moving_seconds: activity.moving_seconds,
			elapsed_seconds: activity.elapsed_seconds,
			distance_m: activity.distance_m,
			elevation_gain_m: activity.elevation_gain_m,
			avg_hr: activity.avg_hr,
			avg_power_w: activity.avg_power_w,
			streams: streams
				? {
						time_s: streams.time_s ?? undefined,
						power_w: streams.power_w ?? undefined,
						heartrate: streams.heartrate ?? undefined,
						altitude_m: streams.altitude_m ?? undefined,
						distance_m: streams.distance_m ?? undefined,
						moving: streams.moving ?? undefined,
					}
				: undefined,
			ski_segments: override,
		},
		thresholds ?? EMPTY_THRESHOLDS,
	);

	const round = (v: number | null, dp = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));
	const { error } = await supabaseAdmin
		.from('activities')
		.update({
			ski_segments: override,
			exertion: round(ex.score),
			exertion_method: ex.method,
			exertion_confidence: ex.confidence,
			intensity_factor: round(ex.intensityFactor, 3),
			updated_at: new Date().toISOString(),
		})
		.eq('id', id)
		.is('deleted_at', null);
	if (error) throw new Error(`saveSkiSegments failed: ${error.message}`);
	return true;
}

/** Shift one activity's distance from one gear row's running total to another. */
/**
 * Delete an activity. Soft: every read in this file (and the activity_list
 * view) already filters on `deleted_at is null`, so stamping it removes the
 * activity from the site completely while leaving the row — and the streams
 * table that references it — intact for a hand-written `update ... set
 * deleted_at = null` if it turns out to have been a mistake.
 *
 * The gear it was logged against gets its distance back, which is the reason
 * this can't just be an `update` at the call site: an activity's distance is
 * on a bike's odometer as well as its own row, and deleting one without the
 * other leaves the gear reading permanently long.
 */
export async function deleteActivity(id: number): Promise<boolean> {
	const current = await getActivity(id);
	if (!current) return false;

	const { error } = await supabaseAdmin
		.from('activities')
		.update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
		.eq('id', id)
		.is('deleted_at', null);
	if (error) throw new Error(`deleteActivity failed: ${error.message}`);

	await moveGearDistance(current.gear_id, null, current.distance_m ?? 0);
	return true;
}

async function moveGearDistance(from: number | null, to: number | null, distanceM: number): Promise<void> {
	if (!distanceM) return;
	for (const [gearId, delta] of [[from, -distanceM], [to, distanceM]] as const) {
		if (gearId == null) continue;
		const { data } = await supabaseAdmin.from('activity_gear').select('distance_m').eq('id', gearId).maybeSingle();
		if (!data) continue;
		const next = Math.max(0, (data.distance_m ?? 0) + delta);
		await supabaseAdmin.from('activity_gear').update({ distance_m: next, updated_at: new Date().toISOString() }).eq('id', gearId);
	}
}

// ---------------------------------------------------------------------------
// listRoutePolylines — /activities/heatmap.
// ---------------------------------------------------------------------------

/**
 * Every outdoor activity's full-fidelity polyline, all-time — the heatmap's
 * whole input. Selects three columns rather than `*` because this is the one
 * read in the file that deliberately fetches the entire collection at once:
 * a `select('*')` here would drag every stat column across the wire for
 * nothing.
 *
 * NON-VIRTUAL ONLY. A Zwift ride can carry a polyline (of a road in
 * Watopia), and drawing it beside real rides would be a claim about ground
 * the athlete has covered that isn't true. `indoor` is decided by sports.ts's
 * sportMeta — the one place a sport's nature is decided (ACTIVITIES.md §6) —
 * plus the `sub_sport = 'indoor'` marker listActivities' indoor filter also
 * reads.
 *
 * MULTISPORT LEGS, NOT THEIR PARENT. A triathlon's parent row and its legs
 * can both carry a track over the same ground; counting both would make a
 * tile crossed once look crossed twice. Any row that turns out to be some
 * other row's parent is dropped in favour of its legs.
 *
 * SIMPLIFIED BEFORE IT LEAVES. The stored tracks are ~1 Hz: 5.1M points
 * across the collection, 10.5 MB encoded, which is a page load nobody waits
 * out. RDP at 8 m cuts that to ~1 MB and changes nothing either view can
 * show — the tiles are 45.7 m across, and the route lines are 2 px wide at
 * the zooms this page lives at. It is the same trade route-shape.ts already
 * makes for card thumbnails, at a tolerance an order of magnitude tighter.
 */
const HEATMAP_SIMPLIFY_M = 8;

function simplifyPoints(points: [number, number][]): [number, number][] {
	if (points.length < 3) return points;
	// Projected, because RDP's tolerance has to be in metres and degrees of
	// longitude aren't. Mercator's scale error doesn't matter at 8 m.
	const projected = points.map(([lat, lng]) => mercator(lat, lng));
	const kept = simplify(projected, HEATMAP_SIMPLIFY_M);
	// simplify() returns the surviving elements themselves, in order, so the
	// original lat/lng pairs come back by walking the two in lockstep — no
	// inverse projection, no index bookkeeping.
	const out: [number, number][] = [];
	for (let i = 0, j = 0; i < projected.length && j < kept.length; i++) {
		if (projected[i] === kept[j]) {
			out.push(points[i]);
			j++;
		}
	}
	return out;
}

/**
 * One activity's polyline as one *or more* simplified polylines — split at the
 * recording gaps a paused-and-relocated watch leaves behind (splitOnGaps), so
 * the heatmap never draws (or unlocks tiles along) the straight diagonal
 * between where a ride stopped and where it picked back up. A continuous track
 * stays a single string; a paused one becomes one string per continuous piece.
 *
 * The split runs on the RAW ~1 Hz polyline, before simplification: after RDP a
 * long straight road is also just two far-apart points, indistinguishable from
 * a pause, so a gap can only be told from real travel while the 1 Hz samples
 * that bracket it are still present.
 */
function splitTrack(polyline: string): string[] {
	return splitOnGaps(decodePolyline(polyline))
		.map(simplifyPoints)
		.filter((piece) => piece.length >= 2)
		.map(encodePolyline);
}

export async function listRoutePolylines(isOwner = false): Promise<{ family: SportFamily; polyline: string }[]> {
	const PAGE = 1000;
	const rows: { id: number; parent_id: number | null; sport: string; sub_sport: string | null; polyline: string }[] = [];

	for (let offset = 0; ; offset += PAGE) {
		// A track is the single most identifying thing this table holds — it
		// starts at a front door. A visitor gets the published ones only, at the
		// query, so a private route is never even loaded into a process that is
		// answering a stranger.
		let req = supabasePublic
			.from('activity_list')
			.select('id, parent_id, sport, sub_sport, polyline')
			.not('polyline', 'is', null);
		if (!isOwner) req = req.eq('private', false);
		const { data, error } = await req.range(offset, offset + PAGE - 1);
		if (error) {
			if (isDegraded(error)) return [];
			throw new Error(`listRoutePolylines failed: ${error.message}`);
		}
		const page = (data ?? []) as typeof rows;
		rows.push(...page);
		if (page.length < PAGE) break;
	}

	const parents = new Set(rows.map((r) => r.parent_id).filter((id): id is number => id != null));
	return rows
		.filter((r) => !parents.has(r.id) && r.sub_sport !== 'indoor' && !sportMeta(r.sport).indoor)
		.flatMap((r) => splitTrack(r.polyline).map((polyline) => ({ family: sportMeta(r.sport).family, polyline })));
}
