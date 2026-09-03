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
import type { AthleteThresholds } from './activities';

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

/** One metric's history, oldest first, nulls dropped — what the graph plots
 *  and what the "since" arrow is computed from. */
export interface Series {
	metric: Metric;
	points: { date: string; value: number }[];
}

export function seriesOf(metric: Metric, rows: AthleteThresholds[]): Series {
	const points = rows
		.map((r) => ({ date: r.effective_from, value: metric.read(r) }))
		.filter((p): p is { date: string; value: number } => p.value != null)
		.map((p) => ({ date: p.date, value: metric.toDisplay(p.value) }))
		.sort((a, b) => a.date.localeCompare(b.date));
	return { metric, points };
}
