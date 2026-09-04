// The detail page's stat layout — split into the three headline figures
// (distance, moving time, exertion) the page leads with and the Avg/Max table
// of everything else beneath them. Kept out of the .astro frontmatter so the
// selection rules read as data, not markup.
//
// The table reuses sports.ts wholesale: `isStatRelevant` decides what a sport
// shows, `formatStat` renders every value, and a '—' from either is dropped
// rather than printed. This file only decides ORDER and which pairs of stats
// (speed avg/max, HR avg/max) collapse into one labelled row with two columns —
// the shape of the example the redesign is drawn from.

import { formatStat, sportMeta, isStatRelevant, type StatKey, type StatRow } from './sports';

/** One row of the Avg/Max table. `max` is present only for the avg/max pairs
 *  (speed, heart rate); every other stat is a single value in the Avg column. */
export interface DetailRow {
	label: string;
	avg: string;
	max?: string;
}

// The three figures the header leads with — never in the table below.
const HEADLINE: StatKey[] = ['distance', 'moving_time', 'exertion'];

// avg/max pairs that share one labelled row with two value columns.
const PAIRS: { avg: StatKey; max: StatKey; label: string }[] = [
	{ avg: 'avg_speed', max: 'max_speed', label: 'Speed' },
	{ avg: 'avg_hr', max: 'max_hr', label: 'Heart rate' },
];

// Table order, top to bottom. A key absent here never renders; a key here with
// no value (or gated out for the sport) is dropped by the filter below.
const ORDER: StatKey[] = [
	'avg_speed',
	'max_speed',
	'avg_pace',
	'pace_100m',
	'avg_hr',
	'max_hr',
	'avg_power',
	'normalized_power',
	'work_kj',
	'elevation_gain',
	'vertical_descent',
	'elev_high',
	'runs',
	'swolf',
	'pool_length',
	'calories',
	'elapsed_time',
	'water_temp',
];

/**
 * The Avg/Max table for one activity. `skiActive` drops moving-derived stats a
 * lift-served day's file lies about (the "Runs & lifts" breakdown owns that
 * time) — same guard the page already applies to its secondary block.
 */
export function detailRows(sport: string, row: StatRow, skiActive: boolean): DetailRow[] {
	const meta = sportMeta(sport);
	// A sport reads its pace in exactly one unit; the other two renderings of the
	// same speed column are suppressed (see the PACE_KEYS note in the detail page).
	const paceKey: StatKey | null =
		meta.paceStyle === 'per_km' ? 'avg_pace' : meta.paceStyle === 'per_100m' ? 'pace_100m' : meta.paceStyle === 'speed' ? 'avg_speed' : null;
	const speedShown = paceKey === 'avg_speed';

	const eligible = ORDER.filter((k) => {
		if (HEADLINE.includes(k)) return false;
		// Speed avg/max belong to speed-paced sports; a runner sees Pace, not a
		// lone "Max speed" with no average beside it.
		if ((k === 'avg_speed' || k === 'max_speed') && !speedShown) return false;
		// Only the sport's own pace unit, never all three at once.
		if ((k === 'avg_pace' || k === 'pace_100m') && k !== paceKey) return false;
		if (skiActive && k === 'moving_time') return false;
		if (!isStatRelevant(sport, k)) return false;
		return formatStat(k, row).value !== '—';
	});

	const eligibleSet = new Set(eligible);
	const used = new Set<StatKey>();
	const rows: DetailRow[] = [];
	for (const k of eligible) {
		if (used.has(k)) continue;
		const pair = PAIRS.find((p) => p.avg === k);
		if (pair && eligibleSet.has(pair.max)) {
			used.add(pair.avg);
			used.add(pair.max);
			rows.push({ label: pair.label, avg: formatStat(pair.avg, row).value, max: formatStat(pair.max, row).value });
			continue;
		}
		const f = formatStat(k, row);
		rows.push({ label: f.label, avg: f.value });
	}
	return rows;
}
