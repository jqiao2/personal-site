// The athlete's own numbers — the vocabulary shared by /activities/athlete and
// its form. Pure: units in, units out, no DB client, so the page can render the
// table with it server-side and the form's client script can parse input with
// the exact same rules.
//
// WHY DISPLAY UNITS DIFFER FROM STORED UNITS. athlete_thresholds stores what
// exertion.ts wants to compute with — seconds per km, kilograms — because
// every consumer of a threshold is a formula, not a person. But the person
// entering these knows their weight in pounds and their threshold pace as
// "6:40 a mile", and asking them to convert is how a wrong number gets typed.
// So the storage unit is the metric one and the *only* place the imperial one
// exists is this file, at the edge.
import type { AthleteThresholds, WeighIn } from './activities';

export const KM_PER_MILE = 1.609344;
export const LB_PER_KG = 2.20462262;
export const CM_PER_INCH = 2.54;

/** How a value moves when training goes well. Paces and resting HR fall;
 *  everything else rises. Drives nothing but the arrow in the table — a
 *  graph line pointing down is otherwise ambiguous. */
export type Direction = 'up' | 'down' | 'none';

export interface Metric {
	/** The column, or a derived key for the ones with no column of their own. */
	key: string;
	label: string;
	/** Unit shown next to the number, and in the input's suffix. */
	unit: string;
	better: Direction;
	/** Stored value → display number. Identity where the units already agree. */
	toDisplay: (stored: number) => number;
	/** Display number → stored value. Absent on derived metrics, which have
	 *  no input and are never written. */
	toStored?: (display: number) => number;
	/** Renders a display number as text — mm:ss for paces, fixed decimals
	 *  elsewhere. */
	format: (display: number) => string;
	/** Pulls the value out of a row, in stored units. */
	read: (t: AthleteThresholds) => number | null;
	/** Paces are typed as mm:ss, not as a decimal. */
	pace?: boolean;
	derived?: boolean;
	/** Comes from the smart scale (body_weight), not from a typed threshold row.
	 *  The page drops it from the thresholds form/table and feeds it the daily
	 *  weigh-in series instead. */
	scaleFed?: boolean;
}

/** `398` → `6:38`. Seconds, floored to the second — a pace is not precise to
 *  the tenth and showing one implies it is. */
export function formatPace(seconds: number): string {
	const s = Math.round(seconds);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `6:38` → `398`. Also takes a bare number of seconds, and `6.38` is NOT
 *  treated as 6:38 — a decimal minute is a real way to write a pace, so
 *  `6.5` means six and a half minutes. Returns null on anything else. */
export function parsePace(input: string): number | null {
	const text = input.trim();
	if (!text) return null;
	const colon = text.match(/^(\d+):([0-5]?\d)$/);
	if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
	const n = Number(text);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n < 30 ? n * 60 : n; // "6.5" is minutes; "398" is already seconds
}

const round = (n: number, places: number) => Number(n.toFixed(places));

export const METRICS: Metric[] = [
	{
		key: 'ftp_w',
		label: 'FTP',
		unit: 'W',
		better: 'up',
		toDisplay: (v) => v,
		toStored: (v) => Math.round(v),
		format: (v) => String(Math.round(v)),
		read: (t) => t.ftp_w,
	},
	{
		key: 'w_per_kg',
		label: 'Power to weight',
		unit: 'W/kg',
		better: 'up',
		derived: true,
		toDisplay: (v) => v,
		format: (v) => v.toFixed(2),
		read: (t) => (t.ftp_w && t.weight_kg ? t.ftp_w / t.weight_kg : null),
	},
	{
		key: 'lthr_bpm',
		label: 'LTHR',
		unit: 'bpm',
		better: 'up',
		toDisplay: (v) => v,
		toStored: (v) => Math.round(v),
		format: (v) => String(Math.round(v)),
		read: (t) => t.lthr_bpm,
	},
	{
		key: 'max_hr',
		label: 'Max HR',
		unit: 'bpm',
		better: 'none',
		toDisplay: (v) => v,
		toStored: (v) => Math.round(v),
		format: (v) => String(Math.round(v)),
		read: (t) => t.max_hr,
	},
	{
		key: 'rest_hr',
		label: 'Resting HR',
		unit: 'bpm',
		better: 'down',
		toDisplay: (v) => v,
		toStored: (v) => Math.round(v),
		format: (v) => String(Math.round(v)),
		read: (t) => t.rest_hr,
	},
	{
		key: 'threshold_pace_s_per_km',
		label: 'Threshold pace',
		unit: '/mi',
		better: 'down',
		pace: true,
		toDisplay: (v) => v * KM_PER_MILE,
		toStored: (v) => v / KM_PER_MILE,
		format: formatPace,
		read: (t) => t.threshold_pace_s_per_km,
	},
	{
		key: 'css_pace_s_per_100m',
		label: 'Critical swim speed',
		unit: '/100m',
		better: 'down',
		pace: true,
		toDisplay: (v) => v,
		toStored: (v) => v,
		format: formatPace,
		read: (t) => t.css_pace_s_per_100m,
	},
	{
		key: 'weight_kg',
		label: 'Weight',
		unit: 'lb',
		better: 'none',
		scaleFed: true,
		toDisplay: (v) => round(v * LB_PER_KG, 1),
		toStored: (v) => v / LB_PER_KG,
		format: (v) => v.toFixed(1),
		read: (t) => t.weight_kg,
	},
	{
		key: 'height_cm',
		label: 'Height',
		unit: 'in',
		better: 'none',
		toDisplay: (v) => round(v / CM_PER_INCH, 1),
		toStored: (v) => v * CM_PER_INCH,
		format: (v) => v.toFixed(1),
		read: (t) => t.height_cm,
	},
];

// ---------------------------------------------------------------------------
// Weigh-in ingest — the pure edge of POST /api/activities/weight. Kept here,
// beside LB_PER_KG and the display helpers, so the unit conversion and the
// one-row-per-day rule are decided in one tested place rather than in the route.
// ---------------------------------------------------------------------------

export interface WeighInInput {
	weight?: unknown;
	unit?: unknown;
	date?: unknown;
	source?: unknown;
}

export interface WeighInRow {
	measured_on: string;
	weight_kg: number;
	source: string;
}

/** How far a reading may sit from the last accepted weight before the ingest
 *  treats it as a scale mis-read. 10% is generous — real day-to-day swing is a
 *  percent or two — so this only catches gross errors, not a heavy meal. */
export const OUTLIER_FRACTION = 0.1;

/** Validate and normalise a batch of weigh-ins (one item is just a batch of
 *  one). Converts to kg, defaults unit to lb and source to apple_health, and
 *  collapses to one row per calendar day — a backfill often carries two
 *  readings on a day, and body_weight's primary key is the day, so the last
 *  item for a day wins (Postgres also refuses to upsert the same key twice in
 *  one statement). Returns the first problem rather than a partial write, so a
 *  malformed sample can't quietly drop a day. `today` is injected for the rare
 *  dateless item, so the function stays pure and testable. */
export function parseWeighIns(items: WeighInInput[], today: string): { rows: WeighInRow[] } | { error: string } {
	if (items.length === 0) return { error: 'no weigh-ins in the request' };
	const byDay = new Map<string, WeighInRow>();
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		const w = Number(it.weight);
		if (!Number.isFinite(w) || w <= 0) return { error: `item ${i}: weight must be a positive number` };
		const unit = it.unit ?? 'lb';
		if (unit !== 'lb' && unit !== 'kg') return { error: `item ${i}: unit must be 'lb' or 'kg'` };
		const weight_kg = unit === 'lb' ? w / LB_PER_KG : w;
		// The scale can't read a person outside this band; anything here is a
		// unit slip, and the DB's own check would reject it.
		if (weight_kg < 20 || weight_kg > 300) return { error: `item ${i}: weight out of range — check the unit` };
		// A full Health timestamp ("2024-03-15 07:30:00 -0700") reduces to its
		// day; the Shortcut should format that in device-local time so a
		// late-night weigh-in lands on the right date.
		const measured_on = (it.date == null ? today : String(it.date).trim()).slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(measured_on)) return { error: `item ${i}: date must be YYYY-MM-DD` };
		byDay.set(measured_on, {
			measured_on,
			weight_kg,
			source: typeof it.source === 'string' ? it.source : 'apple_health',
		});
	}
	return { rows: [...byDay.values()] };
}

/** Decide `ignored` for each incoming weigh-in — a guard against scale
 *  mis-reads (a foot half-off, a bag on the platform), not against real change.
 *
 *  A reading is ignored only when it disagrees with BOTH the last accepted
 *  weight AND the next reading — a lone spike. One that the next reading
 *  confirms is a new plateau (a real gain or loss) and is accepted, becoming
 *  the baseline; otherwise a genuine sustained change would be rejected
 *  wholesale, every reading measured forever against a frozen old weight. The
 *  last reading in the series has nothing after it to confirm against, so it
 *  falls back to the plain "> fraction from baseline" test — which is also
 *  exactly the live daily case, one new reading with no next, where a sudden
 *  jump should be flagged on the spot.
 *
 *  `accepted` is the weigh-ins already trusted (listWeighIns returns only
 *  those); it and the incoming rows are walked together in date order. A
 *  re-measured day is judged against the prior day, not its own stale value, so
 *  its existing accepted row is dropped from the baseline first. The first-ever
 *  reading has no baseline and is always accepted. */
export function flagOutliers(
	accepted: WeighIn[],
	incoming: WeighInRow[],
	fraction: number = OUTLIER_FRACTION,
): (WeighInRow & { ignored: boolean })[] {
	const incomingDates = new Set(incoming.map((r) => r.measured_on));
	const stream = [
		...accepted
			.filter((a) => !incomingDates.has(a.measured_on))
			.map((a) => ({ kg: a.weight_kg, row: null as WeighInRow | null, date: a.measured_on })),
		...incoming.map((r) => ({ kg: r.weight_kg, row: r, date: r.measured_on })),
	].sort((a, b) => a.date.localeCompare(b.date));

	let lastKg: number | null = null;
	const out: (WeighInRow & { ignored: boolean })[] = [];
	for (let k = 0; k < stream.length; k++) {
		const pt = stream[k];
		if (!pt.row) {
			lastKg = pt.kg; // an already-accepted baseline
			continue;
		}
		const offBaseline = lastKg != null && Math.abs(pt.kg - lastKg) / lastKg > fraction;
		// A lone spike also disagrees with the next reading. No next (the most
		// recent reading, and the live single-reading case) → trust the baseline
		// test alone, so a sudden jump is still caught immediately.
		const next = stream[k + 1];
		const offNext = next == null ? true : Math.abs(pt.kg - next.kg) / pt.kg > fraction;
		const ignored = offBaseline && offNext;
		out.push({ ...pt.row, ignored });
		if (!ignored) lastKg = pt.kg;
	}
	return out;
}

/** One metric's history, oldest first, nulls dropped — what the graph plots
 *  and what the "since" arrow is computed from. */
export interface Series {
	metric: Metric;
	points: { date: string; value: number }[];
}

/** The value of every metric in force now: for each field, the latest row that
 *  recorded it, independently. A blank field on the newest row is "unchanged",
 *  not "cleared" — so an FTP entered on 8/25 with weight left blank still shows
 *  the weight from 5/17, and power-to-weight computes from both. Rows come in
 *  newest-first (listThresholds order); null if the table is empty. */
export function inForceNow(rows: AthleteThresholds[]): AthleteThresholds | null {
	if (rows.length === 0) return null;
	const merged = { ...rows[0] };
	for (const m of METRICS) {
		if (m.derived) continue;
		if (merged[m.key as keyof AthleteThresholds] != null) continue;
		const found = rows.find((r) => r[m.key as keyof AthleteThresholds] != null);
		if (found) (merged as Record<string, unknown>)[m.key] = found[m.key as keyof AthleteThresholds];
	}
	return merged;
}

export function seriesOf(metric: Metric, rows: AthleteThresholds[]): Series {
	const points = rows
		.map((r) => ({ date: r.effective_from, value: metric.read(r) }))
		.filter((p): p is { date: string; value: number } => p.value != null)
		.map((p) => ({ date: p.date, value: metric.toDisplay(p.value) }))
		.sort((a, b) => a.date.localeCompare(b.date));
	return { metric, points };
}

const metricByKey = (key: string): Metric => METRICS.find((m) => m.key === key)!;

/** The weight graph — one point per weigh-in, from the scale, not from typed
 *  threshold rows. `weighIns` is oldest-first (listWeighIns's order). */
export function weightSeries(weighIns: WeighIn[]): Series {
	const metric = metricByKey('weight_kg');
	return {
		metric,
		points: weighIns.map((w) => ({ date: w.measured_on, value: metric.toDisplay(w.weight_kg) })),
	};
}

/** The weigh-in in force on a date: the latest one on or before it, in kg.
 *  Null if the scale had recorded nothing yet. `weighIns` is oldest-first. */
export function weightKgOn(date: string, weighIns: WeighIn[]): number | null {
	let kg: number | null = null;
	for (const w of weighIns) {
		if (w.measured_on <= date) kg = w.weight_kg;
		else break;
	}
	return kg;
}

/** Power-to-weight over time: each FTP change paired with the weight in force
 *  on its date — the scale's weigh-in, or the threshold row's own weight_kg for
 *  dates before the scale was syncing, so historical W/kg still resolves. */
export function wPerKgSeries(rows: AthleteThresholds[], weighIns: WeighIn[]): Series {
	const metric = metricByKey('w_per_kg');
	const points = rows
		.filter((r) => r.ftp_w != null)
		.map((r) => {
			const kg = weightKgOn(r.effective_from, weighIns) ?? r.weight_kg;
			return kg ? { date: r.effective_from, value: r.ftp_w! / kg } : null;
		})
		.filter((p): p is { date: string; value: number } => p != null)
		.sort((a, b) => a.date.localeCompare(b.date));
	return { metric, points };
}
