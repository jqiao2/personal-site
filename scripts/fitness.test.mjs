// The runnable check on src/lib/fitness.ts — the Performance Management Chart.
// A slip here is silent: CTL/ATL are plausible numbers whatever the constant,
// and a wrong Form sign or a stretched axis just looks like a different athlete.
//
//   node --import ./scripts/ts-hook.mjs scripts/fitness.test.mjs
import assert from 'node:assert/strict';
import {
	computePmc,
	addDay,
	windowPmc,
	rangeDates,
	plotPmc,
	CTL_DAYS,
	ATL_DAYS,
	PLOT_W,
	PLOT_H,
} from '../src/lib/fitness.ts';

// --- addDay: string in, string out, no UTC drift --------------------------
assert.equal(addDay('2026-01-01', 1), '2026-01-02');
assert.equal(addDay('2026-01-01', -1), '2025-12-31', 'crosses the year');
assert.equal(addDay('2026-03-01', -1), '2026-02-28', 'crosses the month');

// --- computePmc: the model ------------------------------------------------
// Empty in, empty out.
assert.deepEqual(computePmc([], '2026-01-10'), []);

// A single load on the first day, then rest. Day 1's Form is 0 (yesterday had
// nothing), and CTL/ATL both jump by α·load, ATL faster than CTL.
{
	const pmc = computePmc([{ date: '2026-01-01', load: 100 }], '2026-01-03');
	assert.equal(pmc.length, 3, 'first day through today, gaps filled');
	assert.equal(pmc[0].date, '2026-01-01');
	assert.equal(pmc[0].tsb, 0, 'day one starts with zero form');
	assert.ok(pmc[0].atl > pmc[0].ctl, 'fatigue rises faster than fitness');
	// α = 1 − e^(−1/τ); day-one CTL is exactly α_ctl · 100.
	const aCtl = 1 - Math.exp(-1 / CTL_DAYS);
	assert.ok(Math.abs(pmc[0].ctl - Math.round(aCtl * 100 * 10) / 10) < 0.05);
	// Rest days after a hard day: still buried (negative form — fatigue sits
	// well above fitness), but recovering — form rises as the fast average
	// falls toward the slow one, and both averages decay with no load.
	assert.ok(pmc[2].tsb < 0, 'one hard day leaves you fatigued, not fresh');
	assert.ok(pmc[2].tsb > pmc[1].tsb, 'rest recovers form day over day');
	assert.ok(pmc[2].atl < pmc[1].atl && pmc[2].ctl < pmc[1].ctl, 'both decay on rest');
}

// Form is YESTERDAY's balance: today's point equals prior ctl − prior atl.
{
	const pmc = computePmc(
		[{ date: '2026-01-01', load: 80 }, { date: '2026-01-02', load: 120 }],
		'2026-01-04',
	);
	for (let i = 1; i < pmc.length; i++) {
		assert.ok(
			Math.abs(pmc[i].tsb - (pmc[i - 1].ctl - pmc[i - 1].atl)) < 0.11,
			`day ${i} form is the prior day's fitness − fatigue`,
		);
	}
}

// Same-day activities sum into one load; loads after `today` are ignored.
{
	const pmc = computePmc(
		[
			{ date: '2026-01-01', load: 50 },
			{ date: '2026-01-01', load: 50 }, // two rides, one day → 100
			{ date: '2026-06-01', load: 999 }, // beyond today, dropped
		],
		'2026-01-01',
	);
	assert.equal(pmc.length, 1, 'a future load does not extend the series');
	const aCtl = 1 - Math.exp(-1 / CTL_DAYS);
	assert.ok(Math.abs(pmc[0].ctl - Math.round(aCtl * 100 * 10) / 10) < 0.05, 'same day summed to 100');
}

// A steady daily load converges toward that load on both averages, ATL first.
{
	const days = Array.from({ length: 120 }, (_, i) => ({ date: addDay('2026-01-01', i), load: 50 }));
	const pmc = computePmc(days, addDay('2026-01-01', 119));
	const last = pmc[pmc.length - 1];
	assert.ok(Math.abs(last.atl - 50) < 0.5, 'fatigue settles at the steady load');
	assert.ok(last.ctl < last.atl && Math.abs(last.ctl - 50) < 4, 'fitness approaches it more slowly');
	assert.ok(Math.abs(last.tsb) < 4, 'steady state → form near zero');
	assert.ok(ATL_DAYS < CTL_DAYS);
}

// --- windowing ------------------------------------------------------------
{
	const pmc = computePmc(
		Array.from({ length: 400 }, (_, i) => ({ date: addDay('2025-01-01', i), load: 40 })),
		addDay('2025-01-01', 399),
	);
	const today = pmc[pmc.length - 1].date;
	const { from, to } = rangeDates('6m', today);
	assert.equal(to, today);
	assert.equal(from, addDay(today, -182));
	const win = windowPmc(pmc, from, to);
	assert.ok(win.length <= 183 && win.length > 150, '6M window is ~182 days');
	assert.equal(win[win.length - 1].date, today, 'window ends today');
	assert.equal(windowPmc(pmc, null, null).length, pmc.length, 'open window is everything');
	assert.equal(windowPmc(pmc, '2030-01-01', '2030-02-01').length, 0, 'a window past the data is empty');
	assert.equal(rangeDates('all', today).from, null, 'All has no lower bound');
}

// --- plot geometry --------------------------------------------------------
assert.equal(plotPmc([]), null, 'no points, no plot');
{
	const pmc = computePmc(
		[
			{ date: '2026-01-01', load: 200 },
			{ date: '2026-01-05', load: 200 },
			{ date: '2026-01-20', load: 30 },
		],
		'2026-02-01',
	);
	const p = plotPmc(pmc);
	assert.ok(p, 'a real window plots');
	assert.ok(p.lo <= 0, 'the axis includes zero (form dips negative)');
	assert.ok(p.hi > 0);
	// Every drawn coordinate stays inside the box.
	const coords = `${p.ctlLine} ${p.atlLine} ${p.tsbLine}`.split(' ').map((pair) => pair.split(',').map(Number));
	for (const [cx, cy] of coords) {
		assert.ok(cx >= 0 && cx <= PLOT_W, `x ${cx} in box`);
		assert.ok(cy >= 0 && cy <= PLOT_H, `y ${cy} in box`);
	}
	// The zero baseline sits between hi and lo, and the area path closes on it.
	assert.ok(p.zeroY > 0 && p.zeroY < PLOT_H);
	assert.ok(p.tsbArea.startsWith('M') && p.tsbArea.endsWith('Z'), 'form area is a closed polygon');
	assert.ok(p.xTicks.length >= 1 && p.xTicks[0].label.length > 0, 'month ticks are labelled');
	assert.ok(p.yTicks.length >= 1, 'y gridlines exist');
	assert.equal(p.last.date, '2026-02-01', 'last point is today');
}

console.log('fitness.test.mjs: ok');
