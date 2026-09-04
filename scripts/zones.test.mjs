// Runnable check on src/lib/zones.ts — the arithmetic that turns a stream into
// a time-in-zone breakdown. A slip here is silent: the bars still render, they
// just credit the wrong zone or the wrong number of seconds.
//
//   node --import ./scripts/ts-hook.mjs scripts/zones.test.mjs
import assert from 'node:assert/strict';
import { timeInZones, POWER_ZONES, HR_ZONES } from '../src/lib/zones.ts';

// --- classification: 100% of FTP lands in Z4 (Threshold, 91–105%) ----------
{
	const ftp = 250;
	const n = 3600;
	const power = new Array(n).fill(ftp); // an hour exactly at FTP
	const time = Array.from({ length: n }, (_, i) => i);
	const bins = timeInZones(power, time, ftp, POWER_ZONES);
	assert.ok(bins, 'expected bins');
	const z4 = bins.find((b) => b.zone.z === 4);
	assert.equal(Math.round(z4.seconds), 3600, 'all time in Z4 (3599 gaps of 1s + a 1s median tail)');
	assert.equal(bins.filter((b) => b.zone.z !== 4).every((b) => b.seconds === 0), true, 'nothing outside Z4');
	// Absolute bounds off FTP: Z4 is 91–106% → 228–265W (rounded).
	assert.equal(z4.lo, Math.round(ftp * 0.91));
	assert.equal(z4.hi, Math.round(ftp * 1.06));
	// Top zone is open-ended.
	assert.equal(bins.find((b) => b.zone.z === 7).hi, null);
}

// --- HR against LTHR: a value at LTHR is Z5 (Anaerobic, ≥100%) --------------
{
	const lthr = 160;
	const bins = timeInZones([lthr, lthr, lthr], [0, 1, 2], lthr, HR_ZONES);
	assert.ok(bins);
	assert.equal(bins.find((b) => b.seconds > 0).zone.z, 5, 'HR at LTHR is Z5');
}

// --- time-weighting: a 10s sample counts 10× a 1s sample -------------------
{
	// two samples: first held for 10s in Z1 recovery power, second 1s in Z5.
	const ftp = 200;
	const values = [0, ftp * 1.1]; // 0W (Z1), 220W (Z5 vo2max at 110%)
	const time = [0, 10]; // first sample spans 0→10s, last gets median gap (10s)
	const bins = timeInZones(values, time, ftp, POWER_ZONES);
	const z1 = bins.find((b) => b.zone.z === 1).seconds;
	const z5 = bins.find((b) => b.zone.z === 5).seconds;
	assert.equal(z1, 10, 'first sample credited its 10s gap');
	// last sample gets the median gap (10s) but capped at 4× median = 40s → 10s.
	assert.equal(z5, 10, 'last sample credited the median gap');
}

// --- pause guard: a huge time jump is capped, not credited whole -----------
{
	// 100 samples at 1Hz, a 1200s autopause jump, then 100 more at 1Hz — the
	// realistic shape (median gap ≈ 1s, so the cap is 4s and the jump can't
	// dump ~20 minutes into one zone). Uncapped this would total ~1400s; the
	// real recording is ~200s.
	const ftp = 200;
	const values = [];
	const time = [];
	for (let i = 0; i < 100; i++) {
		values.push(ftp * 0.6);
		time.push(i);
	}
	for (let i = 0; i < 100; i++) {
		values.push(ftp * 0.6);
		time.push(1300 + i); // the jump from 99 → 1300
	}
	const bins = timeInZones(values, time, ftp, POWER_ZONES);
	const total = bins.reduce((s, b) => s + b.seconds, 0);
	assert.ok(total < 250, `pause jump capped, total was ${total}s`);
}

// --- guards: no threshold / empty stream → null ----------------------------
assert.equal(timeInZones([100, 100], [0, 1], 0, POWER_ZONES), null, 'no threshold');
assert.equal(timeInZones([], [], 250, POWER_ZONES), null, 'empty stream');
assert.equal(timeInZones([null, undefined], [0, 1], 250, POWER_ZONES), null, 'all-missing stream');

console.log('zones.test.mjs — all assertions passed');
