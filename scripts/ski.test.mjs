// The runnable check on src/lib/ski.ts — lift/run segmentation of the altitude
// sawtooth a resort day records, and the active-descent time exertion.ts scores
// instead of the lift-contaminated file duration.
//
//   node --import ./scripts/ts-hook.mjs scripts/ski.test.mjs
import assert from 'node:assert/strict';
import { detectSkiSegments, summarizeSki, skiActive } from '../src/lib/ski.ts';
import { computeExertion } from '../src/lib/exertion.ts';

// Build a synthetic day: three identical laps of a 300m lift (slow climb) then a
// 300m run (fast drop), sampled every 5s. Small ±3m noise on the lift proves the
// hysteresis doesn't shatter a climb into fragments.
function buildDay() {
	const time = [];
	const altitude = [];
	const distance = [];
	let t = 0;
	let d = 0;
	let alt = 2000;
	const push = (a, dist) => {
		time.push(t);
		altitude.push(a);
		distance.push(d);
		t += 5;
		d += dist;
	};
	for (let lap = 0; lap < 3; lap++) {
		// Lift: +300m over 300s (60 samples), ~2.5 m/s along, jittered.
		for (let i = 0; i < 60; i++) {
			alt += 5;
			push(alt + (i % 2 ? 3 : -3), 12);
		}
		// Run: -300m over 100s (20 samples), fast (~15 m/s along).
		for (let i = 0; i < 20; i++) {
			alt -= 15;
			push(alt, 75);
		}
	}
	return { time_s: time, altitude_m: altitude, distance_m: distance };
}

const day = buildDay();
const segs = detectSkiSegments(day);
const sum = summarizeSki(segs);

assert.equal(sum.runCount, 3, 'three runs found');
assert.equal(sum.liftCount, 3, 'three lifts found');
// Each run drops ~300m; total ~900m, within noise/hysteresis slack.
assert.ok(Math.abs(sum.verticalM - 900) < 60, `vertical ~900m, got ${sum.verticalM}`);
// Run time is 3×100s = 300s, not the 3×300 lift or the 1200s elapsed.
assert.ok(Math.abs(sum.runSeconds - 300) < 40, `run time ~300s, got ${sum.runSeconds}`);
assert.ok(sum.liftSeconds > sum.runSeconds, 'a day is more lift than run');

// A run's average speed is well above a lift's — the segments are labelled right.
const run1 = segs.find((s) => s.type === 'run');
const lift1 = segs.find((s) => s.type === 'lift');
assert.ok(run1.avgSpeedMs > lift1.avgSpeedMs, 'runs are faster than lifts');

// skiActive returns only the run time, and a mask that is true on runs.
const active = skiActive(day);
assert.ok(Math.abs(active.activeSeconds - 300) < 40, 'active seconds ≈ run time');
assert.equal(active.runCount, 3);
assert.equal(active.activeMask.length, day.altitude_m.length, 'mask parallels the stream');

// Exertion: alpine_ski is scored on active descent, not the 1200s elapsed. A MET
// floor over 1200s at 6 MET would be far higher than 300s of active descent, so
// the ski rung must produce the smaller, honest number with method 'ski'.
const ex = computeExertion(
	{
		sport: 'alpine_ski',
		moving_seconds: 1200,
		elapsed_seconds: 1200,
		distance_m: null,
		elevation_gain_m: null,
		avg_hr: null,
		avg_power_w: null,
		streams: day,
	},
	{ ftp_w: null, lthr_bpm: null, max_hr: null, rest_hr: null, threshold_pace_s_per_km: null, css_pace_s_per_100m: null, weight_kg: null },
);
assert.equal(ex.method, 'ski', 'scored via the ski rung');
assert.equal(ex.confidence, 'estimated');
// 300s active = 5min × (7-1) active MET → 30 MET-min → /12/60*100 ≈ 4.2. The
// point is that it's scored off the 5min of skiing, not the 20min elapsed (which
// at the old whole-day MET of 6 would score ~15 — 3.5× higher).
assert.ok(ex.score > 2 && ex.score < 8, `plausible ski exertion for 5min descent, got ${ex.score}`);

// A non-lift sport with the same stream is untouched by the ski path.
const hike = computeExertion(
	{ sport: 'hike', moving_seconds: 1200, elapsed_seconds: 1200, distance_m: 3000, elevation_gain_m: 100, avg_hr: null, avg_power_w: null, streams: day },
	{ ftp_w: null, lthr_bpm: null, max_hr: null, rest_hr: null, threshold_pace_s_per_km: null, css_pace_s_per_100m: null, weight_kg: null },
);
assert.equal(hike.method, 'met', 'a hike still hits the MET floor, not the ski rung');

// No altitude → no segments, and the caller keeps its own moving time.
assert.deepEqual(detectSkiSegments({ time_s: [0, 1, 2] }), []);
assert.equal(skiActive({ time_s: [0, 1, 2] }), null);

console.log('ski.test.mjs OK');
