// The canonical sport table — §6 of ACTIVITIES.md.
//
// Every other track in this section (schema, landing, list, detail, month) is
// being built in parallel against the exact names exported here, so this file
// is the single place a sport's identity is decided: its slug, its label, what
// family of icon it draws, whether it has a route worth drawing, what unit its
// pace is in, and which stats the detail page leads with. Get one of those
// wrong here and it's wrong on every page at once — which is the point of
// having one file rather than five pages each guessing.
//
// WHY A FIXED UNION AND NOT A LOOKUP INTO THE DATABASE. The sports a device can
// report are a closed, slow-changing set (Garmin, Wahoo and Strava all draw
// from a similar controlled vocabulary), and this section is built for one
// athlete's real history, not for an open marketplace of activity types. A
// `text` column with a checked-at-ingest slug is enough; a `sports` table would
// add a join to every list query for a dimension that changes maybe once a
// year. `sportMeta()` is deliberately tolerant of a slug it doesn't recognise
// (falls back to 'other') so a new device string never 500s a page — it just
// looks generic until someone adds it here.
//
// WHY MET LIVES HERE AND NOT IN exertion.ts. The Compendium of Physical
// Activities assigns a MET intensity per *activity type*, which is exactly
// what SPORT_META already indexes by. Keeping it here means the MET table and
// the sport table cannot drift apart — add a sport, its MET value is right
// next to its label instead of in a second file that has to be kept in sync by
// hand. exertion.ts imports `met` off `sportMeta()` rather than keeping its
// own copy.
//
// WHY IMPERIAL FOR EVERYTHING BUT SWIM PACE. This is a US athlete's log:
// distance, elevation and speed read as miles, feet and mph everywhere, the
// way his watch already displays them. Swimming is the one deliberate
// exception — pools are built and swum in metres (a "25" or a "50"), so a pace
// of "1:38 / 100yd" would be answering a question nobody asked. Per-100m pace
// stays metric because that's the unit the sport is actually measured in.

export type Sport =
	| 'ride'
	| 'gravel_ride'
	| 'mountain_bike'
	| 'virtual_ride'
	| 'run'
	| 'treadmill_run'
	| 'trail_run'
	| 'swim'
	| 'open_water_swim'
	| 'transition'
	| 'hike'
	| 'walk'
	| 'snowshoe'
	| 'alpine_ski'
	| 'backcountry_ski'
	| 'nordic_ski'
	| 'snowboard'
	| 'inline_skate'
	| 'strength'
	| 'yoga'
	| 'rowing'
	| 'kayak'
	| 'other';

/** Canonical order — §6: roughly how much of this athlete's life each sport is. */
export const SPORTS: readonly Sport[] = [
	'ride',
	'gravel_ride',
	'mountain_bike',
	'virtual_ride',
	'run',
	'treadmill_run',
	'trail_run',
	'swim',
	'open_water_swim',
	'transition',
	'hike',
	'walk',
	'snowshoe',
	'alpine_ski',
	'backcountry_ski',
	'nordic_ski',
	'snowboard',
	'inline_skate',
	'strength',
	'yoga',
	'rowing',
	'kayak',
	'other',
];

/** Groups a sport for icon selection and for any "by family" rollup. Not the
 *  same axis as `Sport` itself — a gravel ride and a mountain bike ride get
 *  different labels but draw the same bike glyph. */
export type SportFamily = 'bike' | 'run' | 'swim' | 'foot' | 'snow' | 'other' | 'transition';

/** Every stat key any sport's `primaryStats` refers to (§6), plus a few every
 *  detail page needs regardless of sport (calories, exertion). `formatStat`
 *  is total over this union — add a key here and there too. */
export type StatKey =
	| 'distance'
	| 'moving_time'
	| 'elapsed_time'
	| 'elevation_gain'
	| 'avg_power'
	| 'normalized_power'
	| 'avg_speed'
	| 'avg_pace'
	| 'pace_100m'
	| 'avg_hr'
	| 'max_hr'
	| 'swolf'
	| 'pool_length'
	| 'work_kj'
	| 'exertion'
	| 'elev_high'
	| 'vertical_descent'
	| 'max_speed'
	| 'runs'
	| 'water_temp'
	| 'calories';

/** Which unit family a sport's pace/speed stat reads in. `'none'` means the
 *  sport has no meaningful pace (strength, transitions). */
export type PaceStyle = 'speed' | 'per_km' | 'per_100m' | 'none';

export interface SportMeta {
	label: string;
	family: SportFamily;
	/** Icon key, not the path itself — `sportIcon()` resolves the actual
	 *  24x24 path data by family (see the icon set below). Kept as its own
	 *  field, one per sport rather than one per family, so a future finer
	 *  icon (a downhill-specific mark distinct from nordic, say) has
	 *  somewhere to attach without changing this table's shape. */
	icon: string;
	indoor: boolean;
	hasDistance: boolean;
	paceStyle: PaceStyle;
	/** Ordered stat list the detail page leads with — §6. */
	primaryStats: StatKey[];
	/** Compendium of Physical Activities MET value at this athlete's typical
	 *  intensity for the sport. See exertion.ts's MET_TABLE for the sourcing
	 *  argument; this is the resting-multiplier the cascade's floor rung uses
	 *  when nothing else in the record is measurable. */
	met: number;
}

const RIDE_PRIMARY: StatKey[] = [
	'distance',
	'elevation_gain',
	'moving_time',
	'avg_power',
	'normalized_power',
	'avg_speed',
	'exertion',
];

const RUN_PRIMARY: StatKey[] = ['distance', 'moving_time', 'avg_pace', 'avg_hr', 'elevation_gain', 'exertion'];

const SWIM_PRIMARY: StatKey[] = ['distance', 'moving_time', 'pace_100m', 'swolf', 'pool_length', 'exertion'];

const SNOW_PRIMARY: StatKey[] = ['vertical_descent', 'runs', 'max_speed', 'moving_time'];

const DEFAULT_PRIMARY: StatKey[] = ['distance', 'moving_time', 'elevation_gain', 'avg_hr', 'exertion'];

export const SPORT_META: Record<Sport, SportMeta> = {
	ride: {
		label: 'Ride',
		family: 'bike',
		icon: 'bike',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: RIDE_PRIMARY,
		met: 8, // 16-19mph, moderate road effort
	},
	gravel_ride: {
		label: 'Gravel ride',
		family: 'bike',
		icon: 'bike',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: RIDE_PRIMARY,
		met: 8.5, // unpaved surface, more resistance than road at the same speed
	},
	mountain_bike: {
		label: 'Mountain bike',
		family: 'bike',
		icon: 'bike',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: RIDE_PRIMARY,
		met: 8.5, // singletrack, general
	},
	virtual_ride: {
		label: 'Virtual ride',
		family: 'bike',
		icon: 'bike',
		indoor: true,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: ['moving_time', 'avg_power', 'normalized_power', 'avg_hr', 'work_kj', 'exertion'],
		met: 8, // stationary trainer, moderate
	},
	run: {
		label: 'Run',
		family: 'run',
		icon: 'run',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: RUN_PRIMARY,
		met: 9.8, // ~10min/mile
	},
	treadmill_run: {
		label: 'Treadmill run',
		family: 'run',
		icon: 'run',
		indoor: true,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'moving_time', 'avg_pace', 'avg_hr', 'exertion'],
		met: 9.8,
	},
	trail_run: {
		label: 'Trail run',
		family: 'run',
		icon: 'run',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: RUN_PRIMARY,
		met: 9.5, // slower pace than road, offset by terrain/climbing cost
	},
	swim: {
		label: 'Swim',
		family: 'swim',
		icon: 'swim',
		indoor: true,
		hasDistance: true,
		paceStyle: 'per_100m',
		primaryStats: SWIM_PRIMARY,
		met: 6, // lap swimming, moderate/vigorous freestyle
	},
	open_water_swim: {
		label: 'Open water swim',
		family: 'swim',
		icon: 'swim',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_100m',
		primaryStats: ['distance', 'moving_time', 'pace_100m', 'water_temp', 'exertion'],
		met: 8, // open water, current/wetsuit drag, treated as vigorous
	},
	transition: {
		label: 'Transition',
		family: 'transition',
		icon: 'transition',
		indoor: false,
		hasDistance: false,
		paceStyle: 'none',
		// §6: "elapsed time. That is the whole story of a transition." No other
		// stat is even meaningful — there's no moving/stopped distinction to a
		// transition, so elapsed IS the effort.
		primaryStats: ['elapsed_time'],
		met: 3, // standing, changing gear — light, not worth resolving further
	},
	hike: {
		label: 'Hike',
		family: 'foot',
		icon: 'hike',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'elevation_gain', 'moving_time', 'elev_high', 'exertion'],
		met: 6, // cross-country hiking, general
	},
	walk: {
		label: 'Walk',
		family: 'foot',
		icon: 'hike',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: DEFAULT_PRIMARY,
		met: 3.5, // brisk walking pace
	},
	snowshoe: {
		label: 'Snowshoe',
		family: 'foot',
		icon: 'hike',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'elevation_gain', 'moving_time', 'elev_high', 'exertion'],
		met: 7.5, // snow travel, soft/loose surface
	},
	alpine_ski: {
		label: 'Alpine ski',
		family: 'snow',
		icon: 'ski',
		indoor: false,
		hasDistance: false,
		paceStyle: 'speed',
		primaryStats: SNOW_PRIMARY,
		met: 6, // downhill, moderate effort — most of a resort day is the lift, not the run
	},
	backcountry_ski: {
		label: 'Backcountry ski',
		family: 'snow',
		icon: 'ski',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'elevation_gain', 'moving_time', 'elev_high', 'exertion'],
		met: 9.5, // skinning uphill under load — closer to mountaineering than to lift skiing
	},
	nordic_ski: {
		label: 'Nordic ski',
		family: 'snow',
		icon: 'ski',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'moving_time', 'avg_hr', 'elevation_gain', 'exertion'],
		met: 9, // cross-country skiing, moderate speed
	},
	snowboard: {
		label: 'Snowboard',
		family: 'snow',
		icon: 'ski',
		indoor: false,
		hasDistance: false,
		paceStyle: 'speed',
		primaryStats: SNOW_PRIMARY,
		met: 5.3, // general snowboarding
	},
	inline_skate: {
		label: 'Inline skate',
		family: 'other',
		icon: 'inline_skate',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: ['distance', 'moving_time', 'avg_speed', 'avg_hr', 'elevation_gain', 'exertion'],
		met: 9.8, // Compendium 15592 — in-line skating, 12 mph, recreational
	},
	strength: {
		label: 'Strength',
		family: 'other',
		icon: 'strength',
		indoor: true,
		hasDistance: false,
		paceStyle: 'none',
		primaryStats: ['moving_time', 'avg_hr', 'calories', 'exertion'],
		met: 5, // resistance training, vigorous free weights
	},
	yoga: {
		label: 'Yoga',
		family: 'other',
		icon: 'yoga',
		indoor: true,
		hasDistance: false,
		paceStyle: 'none',
		primaryStats: ['moving_time', 'avg_hr', 'calories'],
		met: 3, // Hatha yoga, general
	},
	rowing: {
		label: 'Rowing',
		family: 'other',
		icon: 'rowing',
		indoor: true,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'moving_time', 'avg_power', 'avg_hr', 'exertion'],
		met: 7, // ergometer, moderate effort
	},
	kayak: {
		label: 'Kayak',
		family: 'other',
		icon: 'kayak',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: ['distance', 'moving_time', 'avg_speed', 'avg_hr', 'exertion'],
		met: 5, // Compendium 18070 — kayaking, moderate effort
	},
	other: {
		label: 'Other',
		family: 'other',
		icon: 'other',
		indoor: false,
		hasDistance: true,
		paceStyle: 'none',
		primaryStats: DEFAULT_PRIMARY,
		met: 5, // general miscellaneous, deliberately unremarkable
	},
};

/**
 * Tolerant lookup — a device or import path handing us a slug we don't
 * recognise (a new Garmin sport type, a typo in a manual entry) must not 500
 * the page. It falls back to `other` and lets that sport's generic stat list
 * and icon carry it until someone adds a proper row above.
 */
export function sportMeta(slug: string): SportMeta {
	return (SPORT_META as Record<string, SportMeta>)[slug] ?? SPORT_META.other;
}

// ---------------------------------------------------------------------------
// Stat formatting
// ---------------------------------------------------------------------------

/** The subset of `activities` columns `formatStat` needs, all optional/null
 *  because a stat's source column is frequently absent for a given sport. */
export interface StatRow {
	distance_m?: number | null;
	moving_seconds?: number | null;
	elapsed_seconds?: number | null;
	elevation_gain_m?: number | null;
	elev_high_m?: number | null;
	elevation_loss_m?: number | null;
	avg_power_w?: number | null;
	normalized_power_w?: number | null;
	avg_speed_ms?: number | null;
	max_speed_ms?: number | null;
	avg_hr?: number | null;
	max_hr?: number | null;
	avg_swolf?: number | null;
	pool_length_m?: number | null;
	work_kj?: number | null;
	exertion?: number | null;
	avg_temp_c?: number | null;
	calories?: number | null;
	/** Not a DB column — the alpine-ski "runs" count comes off lap rows
	 *  (`activity_laps` where `lap_type = 'lap'`), summarised before this is
	 *  called. Optional so every other sport's row can omit it. */
	runs?: number | null;
}

export interface FormattedStat {
	label: string;
	value: string;
	sub?: string;
}

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const MS_TO_MPH = 2.236936;

const MISSING: FormattedStat = { label: '', value: '—' };

function withLabel(label: string, stat: Omit<FormattedStat, 'label'>): FormattedStat {
	return { label, ...stat };
}

function miles(m: number | null | undefined): number | null {
	return m == null ? null : m / METERS_PER_MILE;
}

function feet(m: number | null | undefined): number | null {
	return m == null ? null : m / METERS_PER_FOOT;
}

/** "1h 42m" below an hour drops the hours; below a minute shows seconds. */
function formatDuration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${ss}s`;
}

/** mm:ss, for a pace already expressed as seconds-per-unit. */
function formatPaceSeconds(secPerUnit: number | null): string {
	if (secPerUnit == null || !Number.isFinite(secPerUnit) || secPerUnit <= 0) return '—';
	const s = Math.round(secPerUnit);
	const m = Math.floor(s / 60);
	const ss = String(s % 60).padStart(2, '0');
	return `${m}:${ss}`;
}

/**
 * Renders one stat for display. Every branch is null-safe: a missing input
 * yields `{ value: '—' }` rather than throwing or emitting "NaN" — a detail
 * page assembled from `primaryStats` is going to render stats the activity
 * simply doesn't have (a trainer ride has no elevation), and that has to look
 * like an intentional blank, not a broken render.
 */
export function formatStat(key: StatKey, row: StatRow): FormattedStat {
	switch (key) {
		case 'distance': {
			const mi = miles(row.distance_m);
			return withLabel('Distance', { value: mi == null ? '—' : `${mi.toFixed(mi < 10 ? 2 : 1)} mi` });
		}
		case 'moving_time':
			return withLabel('Moving time', { value: formatDuration(row.moving_seconds) });
		case 'elapsed_time':
			return withLabel('Elapsed time', { value: formatDuration(row.elapsed_seconds) });
		case 'elevation_gain': {
			const ft = feet(row.elevation_gain_m);
			return withLabel('Elevation gain', { value: ft == null ? '—' : `${Math.round(ft).toLocaleString()} ft` });
		}
		case 'elev_high': {
			const ft = feet(row.elev_high_m);
			return withLabel('Elev. high', { value: ft == null ? '—' : `${Math.round(ft).toLocaleString()} ft` });
		}
		case 'vertical_descent': {
			// Alpine skiing has no meaningful "gain" — the day's story is descent,
			// which we recover from elevation_loss_m (the lift itself is never
			// recorded, so gain would just be a proxy for lift-served vertical).
			const ft = feet(row.elevation_loss_m);
			return withLabel('Vertical', { value: ft == null ? '—' : `${Math.round(ft).toLocaleString()} ft` });
		}
		case 'avg_power':
			return withLabel('Avg power', { value: row.avg_power_w == null ? '—' : `${row.avg_power_w}W` });
		case 'normalized_power':
			return withLabel('NP', { value: row.normalized_power_w == null ? '—' : `${row.normalized_power_w}W` });
		case 'avg_speed': {
			const mph = row.avg_speed_ms == null ? null : row.avg_speed_ms * MS_TO_MPH;
			return withLabel('Avg speed', { value: mph == null ? '—' : `${mph.toFixed(1)} mph` });
		}
		case 'max_speed': {
			const mph = row.max_speed_ms == null ? null : row.max_speed_ms * MS_TO_MPH;
			return withLabel('Max speed', { value: mph == null ? '—' : `${mph.toFixed(1)} mph` });
		}
		case 'avg_pace': {
			// s/km stored implicitly via distance+time; recompute from speed so
			// this stays correct even if avg_speed_ms is the only stream present.
			if (row.avg_speed_ms == null || row.avg_speed_ms <= 0) return withLabel('Avg pace', MISSING);
			const secPerMile = METERS_PER_MILE / row.avg_speed_ms;
			return withLabel('Avg pace', { value: `${formatPaceSeconds(secPerMile)} /mi` });
		}
		case 'pace_100m': {
			// Metric on purpose — see the header comment. Pools are measured in
			// metres regardless of what unit the rest of the page is in.
			if (row.avg_speed_ms == null || row.avg_speed_ms <= 0) return withLabel('Pace', MISSING);
			const secPer100m = 100 / row.avg_speed_ms;
			return withLabel('Pace', { value: `${formatPaceSeconds(secPer100m)} /100m` });
		}
		case 'avg_hr':
			return withLabel('Avg HR', { value: row.avg_hr == null ? '—' : `${row.avg_hr} bpm` });
		case 'max_hr':
			return withLabel('Max HR', { value: row.max_hr == null ? '—' : `${row.max_hr} bpm` });
		case 'swolf':
			return withLabel('SWOLF', { value: row.avg_swolf == null ? '—' : String(row.avg_swolf) });
		case 'pool_length': {
			const m = row.pool_length_m;
			if (m == null) return withLabel('Pool length', MISSING);
			// Pools are conventionally named by their nominal length, not their
			// exact metreage (a "25" is 25 yards or 25 metres, not 22.86).
			return withLabel('Pool length', { value: `${Math.round(m)}m` });
		}
		case 'work_kj':
			return withLabel('Work', { value: row.work_kj == null ? '—' : `${Math.round(row.work_kj)} kJ` });
		case 'exertion':
			return withLabel('Exertion', { value: row.exertion == null ? '—' : Math.round(row.exertion).toString() });
		case 'runs':
			return withLabel('Runs', { value: row.runs == null ? '—' : String(row.runs) });
		case 'water_temp':
			return withLabel('Water temp', {
				value: row.avg_temp_c == null ? '—' : `${Math.round((row.avg_temp_c * 9) / 5 + 32)}°F`,
			});
		case 'calories':
			return withLabel('Calories', { value: row.calories == null ? '—' : row.calories.toLocaleString() });
	}
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * One inline path per sport family, 24x24 viewBox, stroke-based single-line
 * glyphs — no fills, so they inherit `currentColor` and sit flat on `granite`
 * text the way the rest of the UI does (§2: "sport is said with a mark and a
 * word, not with twelve hues"). Deliberately NOT one-per-sport: `gravel_ride`
 * and `mountain_bike` are still bikes, and a fourteen-icon set stops reading
 * as a system at 16px, where sixteen glyphs collapse into noise long before
 * seven families do. `sportIcon` looks up by family so a card only has to
 * know a slug.
 *
 * Every path was drawn and checked at 16px on both `snow` and `sky` before
 * being kept — a shape that only reads at 24px is not a usable icon here,
 * since the week grid draws these at 16.
 */
const FAMILY_ICONS: Record<SportFamily, string> = {
	// Bike: frame triangle + two wheels, drawn as three circles' worth of
	// geometry via arcs so it survives being squashed to 16px — a full
	// spoked-wheel glyph disappears at that size, an open triangle doesn't.
	bike: 'M5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 15l4-7h5l4 7M9 8h5M12 15l2-4',
	// Run: a single running stick figure — head, angled torso, forward arm/leg.
	run: 'M15 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM10 21l2-6 3 2 2 4M8 14l3-3-1-4 4 1 2 3M6 10l4-2',
	// Swim: wavy water line under a raised-arm stroke stub, not a swimmer
	// figure — legible at 16px where a full stroke pose isn't.
	swim: 'M4 19c1.5 0 1.5-1.5 3-1.5S8.5 19 10 19s1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5M9 13l4-6 3 3-2 3M13 7l2-2',
	// Foot (hike/walk/snowshoe): a boot print + trail dots ahead of it.
	foot: 'M6 20c0-3 1-5 1-8 0-2-1-3-1-5a2 2 0 0 1 4 0c0 2 2 2 2 5v8M14 8l2 2M17 6l2 2M19 10l2 1',
	// Snow: a single ski/board with two poles crossed behind it — reads as
	// "on snow" without pretending to distinguish alpine from nordic.
	snow: 'M3 17l14-3M6 20l14-3M9 4v14M13 9l6-4M13 13l6 3',
	// Transition: the wetsuit-strip arrow — a bag with an arrow through it,
	// standing for "gear change", the one thing this sport is.
	transition: 'M5 10h10l4 4-4 4H5zM9 10V6h6v4',
	// Other: an unfilled diamond — deliberately the least specific mark in the
	// set, so an unrecognised sport never accidentally borrows another
	// family's meaning.
	other: 'M12 3l7 9-7 9-7-9z',
};

/** Icon path for a sport slug, looked up via its family. Unknown slugs fall
 *  through `sportMeta`'s 'other' default, same as everywhere else. */
export function sportIcon(slug: string): string {
	return FAMILY_ICONS[sportMeta(slug).family];
}
