// Re-score every activity from the streams already in the database.
//
// This is the promise ACTIVITIES.md §3 makes and, until now, could not keep:
// "Implementation lives in src/lib/exertion.ts, as pure functions over streams
// — no database access, no I/O — so it can be re-run over the whole table when
// a threshold changes." The functions were pure from the start; what was
// missing was something to re-run them.
//
// WHY THIS MATTERS MORE THAN IT SOUNDS. Two of the numbers every heart-rate
// score depends on are not measurements:
//
//   rest_hr    ASSUMED. Not observable from activity files at all.
//   lthr_bpm   ESTIMATED at 90% of an observed max HR.
//
// and two more are simply absent, which is why runs and swims without a heart
// rate strap sit on the MET floor rather than being scored on pace:
//
//   threshold_pace_s_per_km   (running — roughly 10K race pace)
//   css_pace_s_per_100m       (swimming — critical swim speed)
//
// The athlete knows all four. Without this script, correcting one of them
// meant re-importing 1768 activities from the archive — twenty minutes, and
// only possible on the machine holding the export. With it, the fix is one
// UPDATE and one pass over data already stored.
//
// Usage:
//   node --import ./scripts/ts-hook.mjs --env-file=.env scripts/recompute-exertion.mjs [options]
//
//   --dry              compute everything, print what would change, write nothing
//   --sport <slug>     only this sport
//   --since <date>     only activities on/after this local_date
//   --set-rest-hr N            update every threshold row's rest_hr first
//   --set-lthr N               …and lthr_bpm
//   --set-threshold-pace M:SS  …and threshold_pace_s_per_km (per km)
//   --set-css M:SS             …and css_pace_s_per_100m (per 100m)
//
// The --set-* flags write to `athlete_thresholds` before recomputing, so
// correcting a number and re-scoring on it is one command.

import { createClient } from '@supabase/supabase-js';
import { computeExertion } from '../src/lib/exertion.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const flag = (n, d) => {
	const i = args.indexOf(n);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = has('--dry');
const SPORT = flag('--sport', null);
const SINCE = flag('--since', null);

/** "4:30" or a plain number of seconds. Paces are typed the way they're read. */
function pace(value) {
	if (!value) return null;
	if (/^\d+:\d{2}$/.test(value)) {
		const [m, s] = value.split(':').map(Number);
		return m * 60 + s;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

const SETS = {
	rest_hr: flag('--set-rest-hr', null) ? Number(flag('--set-rest-hr')) : null,
	lthr_bpm: flag('--set-lthr', null) ? Number(flag('--set-lthr')) : null,
	threshold_pace_s_per_km: pace(flag('--set-threshold-pace', null)),
	css_pace_s_per_100m: pace(flag('--set-css', null)),
};

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (node --env-file=.env ...).');
	process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const log = (...a) => console.error(...a);

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const updates = Object.fromEntries(Object.entries(SETS).filter(([, v]) => v !== null && Number.isFinite(v)));
if (Object.keys(updates).length) {
	log(`updating every athlete_thresholds row: ${JSON.stringify(updates)}`);
	if (!DRY) {
		// Every row: these four are properties of the athlete rather than of a
		// training block, and none of them is versioned in the source data.
		const { error } = await db.from('athlete_thresholds').update(updates).gte('effective_from', '1900-01-01');
		if (error) throw new Error(`update athlete_thresholds: ${error.message}`);
	}
}

const { data: thresholds, error: thErr } = await db
	.from('athlete_thresholds')
	.select('effective_from, ftp_w, lthr_bpm, max_hr, rest_hr, threshold_pace_s_per_km, css_pace_s_per_100m, weight_kg')
	.order('effective_from');
if (thErr) throw new Error(`read athlete_thresholds: ${thErr.message}`);
if (!thresholds?.length) {
	console.error('No athlete_thresholds rows — nothing to score against.');
	process.exit(1);
}
log(`${thresholds.length} threshold periods, ${thresholds[0].effective_from} → ${thresholds[thresholds.length - 1].effective_from}`);

/** The row in force on a date: the latest effective_from <= that date (§5). */
function thresholdsOn(date) {
	let inForce = null;
	for (const t of thresholds) {
		if (t.effective_from <= date) inForce = t;
		else break;
	}
	return {
		ftp_w: inForce?.ftp_w ?? null,
		lthr_bpm: inForce?.lthr_bpm ?? null,
		max_hr: inForce?.max_hr ?? null,
		rest_hr: inForce?.rest_hr ?? null,
		threshold_pace_s_per_km: inForce?.threshold_pace_s_per_km ?? null,
		css_pace_s_per_100m: inForce?.css_pace_s_per_100m ?? null,
		weight_kg: inForce?.weight_kg ?? null,
	};
}

// ---------------------------------------------------------------------------
// Walk the table
// ---------------------------------------------------------------------------

let query = db
	.from('activities')
	.select('id, sport, local_date, moving_seconds, elapsed_seconds, distance_m, elevation_gain_m, avg_hr, avg_power_w, exertion, exertion_method, exertion_confidence, ski_segments')
	.order('id');
if (SPORT) query = query.eq('sport', SPORT);
if (SINCE) query = query.gte('local_date', SINCE);

const activities = [];
for (let from = 0; ; from += 1000) {
	const { data, error } = await query.range(from, from + 999);
	if (error) throw new Error(`read activities: ${error.message}`);
	activities.push(...(data ?? []));
	if (!data || data.length < 1000) break;
}
log(`${activities.length} activities to re-score`);

const stats = { changed: 0, unchanged: 0, methodChanged: {}, failures: [] };
let done = 0;

for (const a of activities) {
	done++;
	if (done % 200 === 0) log(`  ${done}/${activities.length}`);

	// Streams are fetched one activity at a time on purpose: at full device
	// resolution a single ride's arrays run to tens of thousands of samples,
	// and a page of fifty would be hundreds of megabytes in one response.
	const { data: s, error: sErr } = await db
		.from('activity_streams')
		.select('time_s, power_w, heartrate, altitude_m, distance_m, moving')
		.eq('activity_id', a.id)
		.maybeSingle();
	if (sErr) {
		stats.failures.push(`${a.id}: ${sErr.message}`);
		continue;
	}

	let result;
	try {
		result = computeExertion(
			{
				sport: a.sport,
				moving_seconds: a.moving_seconds,
				elapsed_seconds: a.elapsed_seconds,
				distance_m: a.distance_m,
				elevation_gain_m: a.elevation_gain_m,
				avg_hr: a.avg_hr,
				avg_power_w: a.avg_power_w,
				// Honour a hand-corrected ski partition, so a re-score never clobbers
				// an edit with auto-detection (migration 0051).
				ski_segments: a.ski_segments ?? null,
				streams: s
					? {
							time_s: s.time_s ?? undefined,
							power_w: s.power_w ?? undefined,
							heartrate: s.heartrate ?? undefined,
							altitude_m: s.altitude_m ?? undefined,
							distance_m: s.distance_m ?? undefined,
							moving: s.moving ?? undefined,
						}
					: undefined,
			},
			thresholdsOn(a.local_date),
		);
	} catch (err) {
		stats.failures.push(`${a.id}: ${err.message}`);
		continue;
	}

	const score = Number(result.score.toFixed(2));
	const same =
		Math.abs((a.exertion ?? -1) - score) < 0.01 &&
		a.exertion_method === result.method &&
		a.exertion_confidence === result.confidence;
	if (same) {
		stats.unchanged++;
		continue;
	}

	stats.changed++;
	const move = `${a.exertion_method ?? 'none'} → ${result.method}`;
	stats.methodChanged[move] = (stats.methodChanged[move] ?? 0) + 1;

	if (!DRY) {
		const { error } = await db
			.from('activities')
			.update({
				exertion: score,
				exertion_method: result.method,
				exertion_confidence: result.confidence,
				intensity_factor: result.intensityFactor === null ? null : Number(result.intensityFactor.toFixed(3)),
			})
			.eq('id', a.id);
		if (error) stats.failures.push(`${a.id}: ${error.message}`);
	}
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

log('');
log(`${DRY ? 'would change' : 'changed'} ${stats.changed}, unchanged ${stats.unchanged}`);
if (Object.keys(stats.methodChanged).length) {
	log('');
	log('method moves:');
	for (const [move, n] of Object.entries(stats.methodChanged).sort((a, b) => b[1] - a[1])) {
		log(`  ${move.padEnd(20)} ${n}`);
	}
}
if (stats.failures.length) {
	log('');
	log(`${stats.failures.length} failures:`);
	for (const f of stats.failures.slice(0, 20)) log(`  ${f}`);
}
