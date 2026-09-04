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
	parseWeighIns,
	flagOutliers,
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

// --- parseWeighIns: the ingest edge (single + backfill batch) -------------
const TODAY = '2026-09-03';

// unit defaults to lb; kg conversion is the same LB_PER_KG the display uses.
{
	const r = parseWeighIns([{ weight: 165.2, date: '2026-09-01' }], TODAY);
	assert.ok('rows' in r);
	assert.equal(r.rows.length, 1);
	assert.equal(r.rows[0].measured_on, '2026-09-01');
	assert.ok(Math.abs(r.rows[0].weight_kg - 165.2 / LB_PER_KG) < 1e-9, 'lb → kg');
	assert.equal(r.rows[0].source, 'apple_health');
}

// explicit kg is taken as-is; a dateless item falls to `today`.
{
	const r = parseWeighIns([{ weight: 72.5, unit: 'kg' }], TODAY);
	assert.ok('rows' in r);
	assert.equal(r.rows[0].weight_kg, 72.5);
	assert.equal(r.rows[0].measured_on, TODAY, 'no date → today');
}

// A full Health timestamp collapses to its day.
assert.equal(
	parseWeighIns([{ weight: 70, unit: 'kg', date: '2024-03-15 07:30:00 -0700' }], TODAY).rows[0].measured_on,
	'2024-03-15',
);

// Backfill batch: one row per day, last item for a day wins (the table's key
// is the day, and Postgres refuses the same conflict key twice per upsert).
{
	const r = parseWeighIns(
		[
			{ weight: 165, unit: 'lb', date: '2026-08-01' },
			{ weight: 164, unit: 'lb', date: '2026-08-02' },
			{ weight: 163.5, unit: 'lb', date: '2026-08-02' }, // same day, later → wins
		],
		TODAY,
	);
	assert.ok('rows' in r);
	assert.equal(r.rows.length, 2, 'two distinct days');
	const aug2 = r.rows.find((x) => x.measured_on === '2026-08-02');
	assert.ok(Math.abs(aug2.weight_kg - 163.5 / LB_PER_KG) < 1e-9, 'last reading for the day wins');
}

// Rejections stop the whole batch rather than drop a day silently.
assert.ok('error' in parseWeighIns([], TODAY), 'empty batch is an error');
assert.ok('error' in parseWeighIns([{ weight: 0, date: TODAY }], TODAY), 'non-positive weight');
assert.ok('error' in parseWeighIns([{ weight: 165, unit: 'stone', date: TODAY }], TODAY), 'bad unit');
assert.ok('error' in parseWeighIns([{ weight: 5, unit: 'kg', date: TODAY }], TODAY), 'below the range');
assert.ok('error' in parseWeighIns([{ weight: 500, unit: 'kg', date: TODAY }], TODAY), 'above the range');
assert.ok('error' in parseWeighIns([{ weight: 165, date: 'Sept 1' }], TODAY), 'unparseable date');

// --- flagOutliers: the >10% scale-misread guard ---------------------------
const kg = (lb) => lb / LB_PER_KG;
const mk = (date, lb) => ({ measured_on: date, weight_kg: kg(lb), source: 'test' });

// The first reading, with no accepted history, is always kept.
assert.equal(flagOutliers([], [mk('2026-01-01', 165)])[0].ignored, false, 'nothing to judge against');

// Within 10% of the last accepted → kept; a wild reading → ignored, and it
// does NOT poison the baseline for the reading after it.
{
	const accepted = [{ measured_on: '2026-01-01', weight_kg: kg(165) }];
	const flagged = flagOutliers(accepted, [
		mk('2026-01-02', 167), // +1.2% → kept
		mk('2026-01-03', 210), // +27% off 167 → ignored (bag on the scale)
		mk('2026-01-04', 166), // judged vs 167 (last ACCEPTED), not 210 → kept
	]);
	assert.deepEqual(
		flagged.map((r) => [r.measured_on, r.ignored]),
		[
			['2026-01-02', false],
			['2026-01-03', true],
			['2026-01-04', false],
		],
		'an ignored spike never becomes the baseline',
	);
}

// A real sustained gain is NOT flagged: each big step is confirmed by the next
// reading, so the baseline advances instead of freezing (the backfill bug where
// a 155→175→185 climb was rejected wholesale against a frozen 155).
{
	const flagged = flagOutliers(
		[{ measured_on: '2020-01-01', weight_kg: kg(155) }],
		[mk('2021-01-01', 175), mk('2022-01-01', 180), mk('2023-01-01', 185)],
	);
	assert.deepEqual(flagged.map((r) => r.ignored), [false, false, false], 'a confirmed climb is accepted');
}

// A lone spike inside a plateau still gets caught: it disagrees with both sides.
{
	const flagged = flagOutliers(
		[{ measured_on: '2026-05-01', weight_kg: kg(175) }],
		[mk('2026-05-02', 176), mk('2026-05-03', 210), mk('2026-05-04', 177)],
	);
	assert.deepEqual(flagged.map((r) => r.ignored), [false, true, false], 'lone spike between normal readings');
}

// Exactly 10% is within tolerance (strictly greater is the cutoff).
assert.equal(
	flagOutliers([{ measured_on: '2026-02-01', weight_kg: 100 }], [{ measured_on: '2026-02-02', weight_kg: 110, source: 't' }])[0]
		.ignored,
	false,
	'10% exactly is kept',
);
assert.equal(
	flagOutliers([{ measured_on: '2026-02-01', weight_kg: 100 }], [{ measured_on: '2026-02-02', weight_kg: 111, source: 't' }])[0]
		.ignored,
	true,
	'just over 10% is ignored',
);

// A re-measure of an existing day is judged against the PRIOR day, not its own
// stale value: 165 → (re-measure 2026-01-01 as 200) has no prior, so kept.
{
	const accepted = [
		{ measured_on: '2026-03-01', weight_kg: kg(165) },
		{ measured_on: '2026-03-02', weight_kg: kg(166) },
	];
	const flagged = flagOutliers(accepted, [mk('2026-03-02', 190)]); // vs 2026-03-01's 165 → +15% → ignored
	assert.equal(flagged[0].ignored, true, 're-measure judged against the prior day');
}

console.log('athlete.test.mjs: ok');
