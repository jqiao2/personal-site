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
	| 'triathlon'
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
	'triathlon',
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

/** Groups a sport for stat relevance and for any "by family" rollup. Not the
 *  same axis as `Sport` itself, and no longer the axis icons pick on — a
 *  gravel ride and a mountain bike ride share this family and share the SWOLF
 *  gating that hangs off it, but each draws its own glyph. */
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
	 *  24x24 path data out of SPORT_ICONS below. One per sport, so two sports
	 *  in the same family can share a glyph (they just name the same key) or
	 *  diverge (gravel and road ride) without changing this table's shape. */
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
		icon: 'bike_gravel',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: RIDE_PRIMARY,
		met: 8.5, // unpaved surface, more resistance than road at the same speed
	},
	mountain_bike: {
		label: 'Mountain bike',
		family: 'bike',
		icon: 'bike_mtb',
		indoor: false,
		hasDistance: true,
		paceStyle: 'speed',
		primaryStats: RIDE_PRIMARY,
		met: 8.5, // singletrack, general
	},
	virtual_ride: {
		label: 'Virtual ride',
		family: 'bike',
		icon: 'bike_indoor',
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
		icon: 'run_indoor',
		indoor: true,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'moving_time', 'avg_pace', 'avg_hr', 'exertion'],
		met: 9.8,
	},
	trail_run: {
		label: 'Trail run',
		family: 'run',
		icon: 'run_trail',
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
		icon: 'swim_open',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_100m',
		primaryStats: ['distance', 'moving_time', 'pace_100m', 'water_temp', 'exertion'],
		met: 8, // open water, current/wetsuit drag, treated as vigorous
	},
	triathlon: {
		label: 'Triathlon',
		family: 'other',
		icon: 'triathlon',
		indoor: false,
		hasDistance: true,
		paceStyle: 'none',
		// The parent row of a multisport day (§5). Its stats are the DAY's
		// totals, so it leads with the shape of the whole event rather than any
		// one leg's pace — a half ironman's "average speed" is a meaningless
		// blend of swimming, riding and running.
		primaryStats: ['distance', 'moving_time', 'elapsed_time', 'avg_hr', 'exertion'],
		// Never actually used: a parent's exertion is the sum of its legs',
		// each scored by its own sport. Present because the table is total.
		met: 7,
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
		icon: 'walk',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: DEFAULT_PRIMARY,
		met: 3.5, // brisk walking pace
	},
	snowshoe: {
		label: 'Snowshoe',
		family: 'foot',
		icon: 'snowshoe',
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
		icon: 'ski_touring',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'elevation_gain', 'moving_time', 'elev_high', 'exertion'],
		met: 9.5, // skinning uphill under load — closer to mountaineering than to lift skiing
	},
	nordic_ski: {
		label: 'Nordic ski',
		family: 'snow',
		icon: 'ski_nordic',
		indoor: false,
		hasDistance: true,
		paceStyle: 'per_km',
		primaryStats: ['distance', 'moving_time', 'avg_hr', 'elevation_gain', 'exertion'],
		met: 9, // cross-country skiing, moderate speed
	},
	snowboard: {
		label: 'Snowboard',
		family: 'snow',
		icon: 'snowboard',
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

/**
 * Stats that mean something for exactly one family, and are a LIE anywhere else.
 *
 * A page that lists "every stat whose column happens to be non-null" will put
 * "Water temp 57°F" on a gravel ride, because `water_temp` reads `avg_temp_c`
 * and on a bike that column is the AIR. The number is real and the label is
 * false, which is worse than omitting it — the reader has no way to know the
 * stat changed meaning. The same trap holds for the two ski figures: every
 * outdoor activity descends, so `vertical_descent` (from `elevation_loss_m`)
 * will happily render for a ride, where it means rolling terrain rather than
 * the lift-served vertical the label promises.
 *
 * So these keys are gated by family rather than by whether data exists. A key
 * absent from this map is unrestricted and shows wherever it has a value.
 */
const FAMILY_ONLY_STATS: Partial<Record<StatKey, readonly SportFamily[]>> = {
	water_temp: ['swim'],
	pace_100m: ['swim'],
	swolf: ['swim'],
	pool_length: ['swim'],
	vertical_descent: ['snow'],
	runs: ['snow'],
};

/**
 * Whether a stat is meaningful for a sport — the check a secondary "everything
 * else" block needs before it renders a key it did not choose deliberately.
 * A sport's own `primaryStats` are always relevant: that list is the
 * deliberate choice, and this never second-guesses it.
 */
export function isStatRelevant(slug: string, key: StatKey): boolean {
	const meta = sportMeta(slug);
	if (meta.primaryStats.includes(key)) return true;
	const families = FAMILY_ONLY_STATS[key];
	return !families || families.includes(meta.family);
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
 * One inline path per sport, 24x24 viewBox, stroke-based single-line glyphs —
 * no fills, so they inherit `currentColor` and sit flat on `granite` text the
 * way the rest of the UI does (§2: "sport is said with a mark and a word, not
 * with twelve hues").
 *
 * THE SYSTEM. Each glyph is the sport's *object* — a bike, a running shoe, a
 * pair of skis — and its variants are that same object plus one mark in the
 * band under it, never a second object:
 *
 *   - dashes  (`M3 21h3.5…`) — loose surface: gravel ride, trail run.
 *   - a jagged ridge         — mountains: mountain bike, backcountry ski.
 *   - one solid line         — a fixed floor or a pool wall: virtual ride,
 *                              treadmill run, pool swim.
 *   - a wave                 — open water.
 *   - two straight tracks    — set nordic tracks.
 *
 * Reading the modifier is optional: a glance gets "bike" or "shoe" from the
 * object alone, which is all a 16px calendar cell can carry anyway, and the
 * band adds the surface for anyone who looks closer. That is why the variants
 * are NOT distinct drawings — sixteen unrelated glyphs stop reading as a
 * system at 16px, one object plus a surface never does.
 *
 * Keyed by `SportMeta.icon` rather than by family, so a sport can be given its
 * own mark by editing one field in the table above. Every path was drawn and
 * checked at 16, 24 and 48px before being kept — a shape that only reads at
 * 24px is not a usable icon here, since the week grid draws these at 16.
 */
const SPORT_ICONS: Record<string, string> = {
	// Bike: frame triangle + two wheels, drawn as arcs so it survives being
	// squashed to 16px — a full spoked-wheel glyph disappears at that size, an
	// open triangle doesn't. The variants raise the bike 2px to clear the
	// surface band.
	bike: 'M5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 15l4-7h5l4 7M9 8h5M12 15l2-4',
	bike_gravel:
		'M5 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 13l4-7h5l4 7M9 6h5M12 13l2-4M3 21h3.5M10.5 21h3.5M17.5 21h3.5',
	bike_mtb:
		'M5 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 13l4-7h5l4 7M9 6h5M12 13l2-4M2 23l3.5-2.5L9 23l4-2.5 4 2.5 3-2 2 2.5',
	bike_indoor:
		'M5 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 13l4-7h5l4 7M9 6h5M12 13l2-4M3 21h18',
	// Run: a running shoe in profile — heel, ankle collar, tongue, toe box,
	// with the sole as its own line so the silhouette still reads when the
	// laces stop resolving around 16px.
	run: 'M3 17v-4a1 1 0 0 1 1.3-.95l3.2 1.05 2.5-2.6a1 1 0 0 1 1.55.1l1.75 2.5 4 1.4 2.9 2.1a1.8 1.8 0 0 1-1.05 3.25H5a2 2 0 0 1-2-2zM3.5 17.5h16.5M9.5 13.5l2 1.2M11.3 11.6l2 1.2',
	run_trail:
		'M3 15v-4a1 1 0 0 1 1.3-.95l3.2 1.05 2.5-2.6a1 1 0 0 1 1.55.1l1.75 2.5 4 1.4 2.9 2.1a1.8 1.8 0 0 1-1.05 3.25H5a2 2 0 0 1-2-2zM3.5 15.5h16.5M9.5 11.5l2 1.2M11.3 9.6l2 1.2M3 21h3.5M10.5 21h3.5M17.5 21h3.5',
	run_indoor:
		'M3 15v-4a1 1 0 0 1 1.3-.95l3.2 1.05 2.5-2.6a1 1 0 0 1 1.55.1l1.75 2.5 4 1.4 2.9 2.1a1.8 1.8 0 0 1-1.05 3.25H5a2 2 0 0 1-2-2zM3.5 15.5h16.5M9.5 11.5l2 1.2M11.3 9.6l2 1.2M3 21h18',
	// Swim: head, the recovering arm over it, and the body's line — a
	// freestyle stroke, over the pool wall or over open water.
	swim: 'M7.6 11.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM8.8 8.6C10 5.4 13 4.4 15.4 6.2M6 14l5.5-1.7 4.5 2 4-1.5M3 20h18',
	swim_open:
		'M7.6 11.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM8.8 8.6C10 5.4 13 4.4 15.4 6.2M6 14l5.5-1.7 4.5 2 4-1.5M3 20c1.5 0 1.5-1.5 3-1.5S7.5 20 9 20s1.5-1.5 3-1.5S13.5 20 15 20s1.5-1.5 3-1.5S19.5 20 21 20',
	// Hike: the mountain itself, not a boot — at 16px a boot print and a
	// running shoe are the same blob, and two peaks never are.
	hike: 'M2 20l6.5-10 4 6 2.5-3.5L21 20zM8.5 10l2 3',
	walk: 'M13 5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM12.5 7v6M13 13l-3 8M13 13l3 8M12.6 9.5l-3.2 2M12.6 9.5l3.2 2',
	// Snowshoe: the racket seen from above — teardrop frame, three lacings.
	snowshoe:
		'M12 3c3.2 0 5 3 5 7 0 4-1.4 6.6-1.9 10.6a1.5 1.5 0 0 1-1.5 1.3h-3.2a1.5 1.5 0 0 1-1.5-1.3C8.4 16.6 7 14 7 10c0-4 1.8-7 5-7zM7.8 9.5h8.4M8.3 13h7.4M9.2 16.5h5.6',
	// Ski: a pair of skis in perspective, tips curled. The three ski sports
	// differ only in what's under them — mountains skinned up, set tracks, or
	// nothing at all for a lift-served day.
	ski: 'M2.5 15l12-4c1.6-.5 2.6-.2 3.3.9M4.5 18l12-4c1.6-.5 2.6-.2 3.3.9',
	ski_touring: 'M2.5 14l12-4c1.6-.5 2.6-.2 3.3.9M4.5 17l12-4c1.6-.5 2.6-.2 3.3.9M2 23l3.5-2.5L9 23l4-2.5 4 2.5 3-2 2 2.5',
	ski_nordic: 'M2.5 14l12-4c1.6-.5 2.6-.2 3.3.9M4.5 17l12-4c1.6-.5 2.6-.2 3.3.9M3 20h18M3 23h18',
	snowboard: 'M4.6 18.6a3 3 0 0 1 0-4.24L14.36 4.6a3 3 0 0 1 4.24 4.24L8.84 18.6a3 3 0 0 1-4.24 0zM8.2 11.3l3.5 3.5M11.5 8l3.5 3.5',
	inline_skate:
		'M5 17V8l4 1 2.5-2.5L14 9l4 1.5 3 2V17zM6 20.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6zM11 20.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6zM16 20.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6zM20.5 20.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
	strength: 'M3 9v6M6.5 6.5v11M6.5 12h11M17.5 6.5v11M21 9v6',
	// Yoga: the seated figure — head over a lotus base, arms across it.
	yoga: 'M12 6.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM12 8.6L5.5 19.5h13zM8.2 14h7.6',
	// Rowing: the erg, which is what this sport actually is here — rail, seat,
	// chain and flywheel. A boat-and-oars mark would promise water there isn't.
	rowing: 'M3 19h18M8.5 19v-2.5h3.5V19M19 12.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM16.4 11.2L11.5 15.2M11.5 15.2l-2.5.6',
	// Kayak: hull from above with the double paddle laid across it.
	kayak: 'M3 13c4.5 4.5 13.5 4.5 18 0-4.5-4.5-13.5-4.5-18 0zM4 5l16 16M3.5 4l2-1 1 2-2 1zM20.5 20l-2 1-1-2 2-1z',
	// Triathlon: three chevrons — the three legs, in order. Drawing a swim, a
	// bike and a run inside one 24px square gives three unreadable marks
	// instead of one readable one.
	triathlon: 'M4 8l4 4-4 4M11 8l4 4-4 4M18 8l4 4-4 4',
	// Transition: the gear bag with the arrow through it — "gear change", the
	// one thing this sport is.
	transition: 'M5 10h10l4 4-4 4H5zM9 10V6h6v4',
	// Other: an unfilled diamond — deliberately the least specific mark in the
	// set, so an unrecognised sport never accidentally borrows another
	// sport's meaning.
	other: 'M12 3l7 9-7 9-7-9z',
};

/** Icon path for a sport slug. Unknown slugs fall through `sportMeta`'s
 *  'other' default, same as everywhere else; an icon key with no path (a row
 *  added to the table above before its glyph was drawn) falls back to the
 *  same generic mark rather than rendering an empty `<path>`. */
export function sportIcon(slug: string): string {
	return SPORT_ICONS[sportMeta(slug).icon] ?? SPORT_ICONS.other;
}
