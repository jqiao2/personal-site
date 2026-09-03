// The runnable check on src/lib/athlete.ts — the unit edge between what the
// athlete types and what exertion.ts computes with. A slip here is silent: a
// weight stored in pounds still looks like a plausible number, and every
// power-to-weight and rTSS downstream of it is quietly wrong.
//
//   node --import ./scripts/ts-hook.mjs scripts/athlete.test.mjs
import assert from 'node:assert/strict';
import {
	METRICS,
	parsePace,
	formatPace,
	seriesOf,
	weightSeries,
	weightKgOn,
	wPerKgSeries,
	KM_PER_MILE,
	LB_PER_KG,
} from '../src/lib/athlete.ts';

// --- pace parsing ---------------------------------------------------------
assert.equal(parsePace('6:38'), 398);
assert.equal(parsePace('12:05'), 725);
assert.equal(parsePace(' 6:38 '), 398);
assert.equal(parsePace('6.5'), 390, 'a decimal under 30 is minutes');
assert.equal(parsePace('398'), 398, 'a number over 30 is already seconds');
assert.equal(parsePace(''), null);
assert.equal(parsePace('nope'), null);
assert.equal(parsePace('6:75'), null, 'no such second');
assert.equal(formatPace(398), '6:38');
assert.equal(formatPace(600), '10:00');
assert.equal(formatPace(65), '1:05');

// --- round trips ----------------------------------------------------------
// Every editable metric must survive display → stored → display, or the edit
// button silently rewrites a row it only meant to load.
const byKey = Object.fromEntries(METRICS.map((m) => [m.key, m]));
for (const m of METRICS.filter((x) => !x.derived)) {
	const stored = m.read({
		ftp_w: 265,
		lthr_bpm: 168,
		max_hr: 190,
		rest_hr: 48,
		threshold_pace_s_per_km: 250,
		css_pace_s_per_100m: 95,
		weight_kg: 72.5,
		height_cm: 178,
	});
	const back = m.toStored(m.toDisplay(stored));
	assert.ok(Math.abs(back - stored) < 0.1, `${m.key} round trip: ${stored} → ${back}`);
}

// --- the conversions themselves, spot-checked against known values --------
assert.equal(byKey.threshold_pace_s_per_km.format(byKey.threshold_pace_s_per_km.toDisplay(250)), '6:42');
assert.equal(Math.round(250 * KM_PER_MILE), 402);
assert.equal(byKey.weight_kg.toDisplay(72.5), Number((72.5 * LB_PER_KG).toFixed(1)));
assert.equal(byKey.weight_kg.format(byKey.weight_kg.toDisplay(72.5)), '159.8');
assert.equal(byKey.height_cm.format(byKey.height_cm.toDisplay(177.8)), '70.0');
assert.equal(byKey.css_pace_s_per_100m.format(95), '1:35', 'swim pace is stored in its display unit');

// --- derived + series -----------------------------------------------------
assert.equal(byKey.w_per_kg.read({ ftp_w: 265, weight_kg: 72.5 }).toFixed(2), '3.66');
assert.equal(byKey.w_per_kg.read({ ftp_w: 265, weight_kg: null }), null);
assert.equal(byKey.w_per_kg.toStored, undefined, 'derived metrics are never written');

const rows = [
	{ effective_from: '2026-06-01', ftp_w: 270 },
	{ effective_from: '2025-01-01', ftp_w: 250 },
	{ effective_from: '2025-09-01', ftp_w: null },
];
const s = seriesOf(byKey.ftp_w, rows);
assert.deepEqual(
	s.points.map((p) => [p.date, p.value]),
	[
		['2025-01-01', 250],
		['2026-06-01', 270],
	],
	'oldest first, nulls dropped',
);

// --- weigh-ins: the scale-fed weight series (0059) ------------------------
// oldest-first, as listWeighIns returns. weightSeries plots pounds; the graph
// must show one point per weigh-in in display units, unlike the sparse
// threshold-derived series.
const weighIns = [
	{ measured_on: '2026-01-10', weight_kg: 73.0 },
	{ measured_on: '2026-02-14', weight_kg: 72.0 },
	{ measured_on: '2026-03-20', weight_kg: 71.5 },
];
const ws = weightSeries(weighIns);
assert.equal(ws.metric.key, 'weight_kg');
assert.equal(ws.points.length, 3);
assert.equal(ws.points[0].value, Number((73.0 * LB_PER_KG).toFixed(1)), 'plotted in pounds');
assert.equal(weightSeries([]).points.length, 0, 'no scale data → empty series, not a crash');

// weightKgOn: the weigh-in in force on a date is the latest on or before it.
assert.equal(weightKgOn('2026-02-14', weighIns), 72.0, 'exact day');
assert.equal(weightKgOn('2026-03-01', weighIns), 72.0, 'between weigh-ins → the earlier one');
assert.equal(weightKgOn('2027-01-01', weighIns), 71.5, 'after the last → the last');
assert.equal(weightKgOn('2025-12-01', weighIns), null, 'before any weigh-in → null');

// wPerKgSeries: each FTP change paired with the weight in force on its date —
// a weigh-in where one exists, else the threshold row's own weight_kg.
const wpk = wPerKgSeries(
	[
		{ effective_from: '2026-02-01', ftp_w: 265, weight_kg: null }, // uses weigh-in 73.0 (from 2026-01-10)
		{ effective_from: '2025-06-01', ftp_w: 250, weight_kg: 74.0 }, // pre-scale → falls back to row weight
		{ effective_from: '2026-03-25', ftp_w: 270, weight_kg: null }, // uses weigh-in 71.5 (from 2026-03-20)
	],
	weighIns,
);
assert.deepEqual(
	wpk.points.map((p) => [p.date, Number(p.value.toFixed(2))]),
	[
		['2025-06-01', Number((250 / 74.0).toFixed(2))],
		['2026-02-01', Number((265 / 73.0).toFixed(2))],
		['2026-03-25', Number((270 / 71.5).toFixed(2))],
	],
	'oldest first; weigh-in where present, row weight before the scale',
);

console.log('athlete.test.mjs: ok');
