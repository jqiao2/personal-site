// The ingest pipeline's load-bearing logic, checked against real files from a
// Strava export where one is available.
//
// What is worth testing here is narrow but sharp-edged: the things that fail
// SILENTLY and permanently. A misparsed CSV column writes a wrong distance
// forever; a wrong UTC offset files a ride on the wrong calendar day and the
// week grid quietly disagrees with the athlete's memory; an unknown sport
// mapped to 'other' loses information nobody goes back to recover. None of
// those throw on their own, which is exactly why they are asserted here.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/ingest.test.mjs
//      (add a Strava export directory as argv[2] to include the file-parsing
//       checks; without one those are skipped, so this stays runnable in CI.)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
	parseCsv,
	indexHeader,
	readRow,
	parseStravaDate,
	csvRowToCanonical,
	mergeCanonical,
} from '../src/lib/ingest/strava-archive.ts';
import {
	sportFromStrava,
	refineSport,
	offsetMinutesInZone,
	localDate,
	toRows,
	UnknownSportError,
	MAX_STORED_SAMPLES,
} from '../src/lib/ingest/canonical.ts';
import { parseGpx, parseTcx } from '../src/lib/ingest/gpx.ts';
import { parseFit } from '../src/lib/ingest/fit.ts';
import { SPORT_META } from '../src/lib/sports.ts';

const TH = {
	ftp_w: 250,
	lthr_bpm: 170,
	max_hr: 190,
	rest_hr: 50,
	threshold_pace_s_per_km: 270,
	css_pace_s_per_100m: 100,
	weight_kg: 75,
};

// ---------------------------------------------------------------------------
// 1. The CSV reader
// ---------------------------------------------------------------------------

{
	const rows = parseCsv('a,b,c\n1,"two, with comma",3\n4,"say ""hi""",6\r\n');
	assert.deepEqual(rows[0], ['a', 'b', 'c']);
	assert.deepEqual(rows[1], ['1', 'two, with comma', '3'], 'a quoted comma must not split the field');
	assert.deepEqual(rows[2], ['4', 'say "hi"', '6'], 'doubled quotes are one literal quote');

	const multiline = parseCsv('a,b\n1,"line one\nline two"\n');
	assert.equal(multiline[1][1], 'line one\nline two', 'a newline inside quotes stays in the field');
}

// ---------------------------------------------------------------------------
// 2. Duplicate header names — the export's sharpest edge
// ---------------------------------------------------------------------------
//
// activities.csv states `Elapsed Time`, `Distance`, `Max Heart Rate` and
// `Relative Effort` TWICE. The first is Strava's rounded display copy, with
// distance in KILOMETRES; the second is the precise one in metres. Reading the
// first by mistake would silently shrink every distance in the database by a
// factor of a thousand.
{
	const header = ['Activity ID', 'Elapsed Time', 'Distance', 'Elapsed Time', 'Distance'];
	const idx = indexHeader(header);
	assert.equal(idx.col('Distance'), 4, 'col() must give the LAST index — the precise copy');
	assert.equal(idx.firstCol('Distance'), 2, 'firstCol() gives the display copy');

	const row = readRow(['123', '4073', '34.69', '4073.0', '34690.4'], idx);
	assert.equal(row.activityId, '123');
	assert.equal(row.values['Distance'], '34690.4', 'the precise metres copy wins');
}

// ---------------------------------------------------------------------------
// 3. Dates and the local calendar day
// ---------------------------------------------------------------------------

{
	// Strava writes the export's dates as UTC even though they read as local.
	assert.equal(parseStravaDate('Aug 20, 2026, 11:01:45 AM'), '2026-08-20T11:01:45.000Z');
	assert.equal(parseStravaDate('Nov 6, 2016, 5:56:04 PM'), '2016-11-06T17:56:04.000Z');
	assert.equal(parseStravaDate('Jan 1, 2020, 12:30:00 AM'), '2020-01-01T00:30:00.000Z', 'midnight is 12 AM, not 12:00');
	assert.equal(parseStravaDate('Jan 1, 2020, 12:30:00 PM'), '2020-01-01T12:30:00.000Z', 'noon is 12 PM');

	// DST is the reason this uses Intl rather than a fixed number.
	assert.equal(offsetMinutesInZone(new Date('2026-08-20T18:00:00Z'), 'America/Los_Angeles'), -420);
	assert.equal(offsetMinutesInZone(new Date('2026-01-20T18:00:00Z'), 'America/Los_Angeles'), -480);

	// The whole point of local_date: an evening ride must stay on its own day.
	// 2026-08-21T02:00Z is 7pm on the 20th in Pacific time.
	assert.equal(localDate('2026-08-21T02:00:00.000Z', -420), '2026-08-20');
	assert.equal(localDate('2026-08-21T02:00:00.000Z', 0), '2026-08-21', 'and UTC would have got it wrong');
}

// ---------------------------------------------------------------------------
// 4. Sports — an unknown one must stop the import, not become 'other'
// ---------------------------------------------------------------------------

{
	assert.equal(sportFromStrava('Ride'), 'ride');
	assert.equal(sportFromStrava('Inline Skate'), 'inline_skate');
	assert.equal(sportFromStrava('Kayaking'), 'kayak');

	assert.throws(() => sportFromStrava('Kitesurf'), UnknownSportError, 'an unmapped type must throw, never fall back to other');

	// Every slug the mapping can produce must exist in the sport table, or the
	// detail page has no stats to lead with and the MET floor has no value.
	for (const type of ['Ride', 'Run', 'Swim', 'Hike', 'Walk', 'Alpine Ski', 'Inline Skate', 'Kayaking', 'Weight Training']) {
		assert.ok(SPORT_META[sportFromStrava(type)], `${type} maps to a slug with no SPORT_META entry`);
	}

	// The file refines what the csv said; indoors is the bit that matters,
	// because it decides whether the card draws a route at all (§7).
	assert.deepEqual(refineSport('ride', 'cycling', 'indoorCycling'), { sport: 'virtual_ride', sub_sport: 'indoor' });
	assert.deepEqual(refineSport('run', 'running', 'treadmill'), { sport: 'treadmill_run', sub_sport: 'indoor' });
	assert.equal(refineSport('ride', 'cycling', 'generic').sport, 'ride', 'generic must not invent a sub_sport');
	assert.equal(refineSport('ride', 'cycling', 'generic').sub_sport, null);
}

// ---------------------------------------------------------------------------
// 5. The merge direction: measurements from the file, editorial from the csv
// ---------------------------------------------------------------------------

{
	const fromFile = {
		sport: 'virtual_ride',
		sub_sport: 'indoor',
		title: 'Morning Ride', // the head unit's default
		started_at: '2026-08-20T11:01:45.000Z',
		elapsed_seconds: 4074,
		avg_power_w: 195,
		distance_m: 34690.4,
	};
	const fromCsv = {
		sport: 'ride',
		title: 'New tire new me', // what the athlete typed
		notes: 'davis center pool looks yummy',
		private_notes: 'knee felt off',
		started_at: '2026-08-20T11:01:45.000Z',
		elapsed_seconds: 4074,
		avg_power_w: 162,
		calories: 702,
	};

	const merged = mergeCanonical(fromFile, fromCsv);
	assert.equal(merged.title, 'New tire new me', "a device default must never overwrite the athlete's title");
	assert.equal(merged.notes, 'davis center pool looks yummy');
	assert.equal(merged.private_notes, 'knee felt off');
	assert.equal(merged.avg_power_w, 195, 'the file measured it, so the file wins');
	assert.equal(merged.calories, 702, 'and the csv fills what the file lacks');
	assert.equal(merged.sport, 'virtual_ride', 'the file decides indoor vs outdoor');
}

// ---------------------------------------------------------------------------
// 6. Strava's own effort numbers are ignored (§3)
// ---------------------------------------------------------------------------

{
	const header = ['Activity ID', 'Activity Date', 'Activity Type', 'Relative Effort', 'Training Load', 'Moving Time', 'Distance'];
	const idx = indexHeader(header);
	const row = readRow(['9', 'Aug 20, 2026, 11:01:45 AM', 'Ride', '110', '75', '3600', '30000'], idx);
	const canonical = csvRowToCanonical(row);

	assert.ok(!('exertion' in canonical), 'exertion is derived by §3, never read from the provider');
	for (const key of Object.keys(canonical)) {
		assert.ok(
			!/relative_effort|training_load/i.test(key),
			`Strava's own effort model leaked into the canonical shape as ${key}`,
		);
	}

	// And what does get computed states how it got there.
	const { activity } = toRows(canonical, TH);
	assert.ok(activity.exertion > 0);
	assert.ok(['tss', 'hrtss', 'avghr', 'ptss', 'met'].includes(activity.exertion_method));
	assert.ok(['measured', 'estimated', 'assumed'].includes(activity.exertion_confidence));
	assert.notEqual(activity.exertion, 110, "must not have adopted Strava's Relative Effort");
	assert.notEqual(activity.exertion, 75, "must not have adopted Strava's Training Load");
}

// ---------------------------------------------------------------------------
// 7. No GPS is a normal reading, not a gap (§7)
// ---------------------------------------------------------------------------

{
	const poolSwim = {
		sport: 'swim',
		started_at: '2026-03-02T15:00:00.000Z',
		utc_offset_minutes: -480,
		elapsed_seconds: 2400,
		moving_seconds: 2100,
		distance_m: 1500,
		pool_length_m: 25,
		avg_hr: 132,
	};
	const { activity, streams } = toRows(poolSwim, TH);

	assert.equal(activity.route_path, null, 'a pool swim draws no route');
	assert.equal(activity.polyline, null);
	assert.equal(activity.start_lat, null);
	assert.equal(activity.bbox_n, null);
	assert.equal(activity.has_streams, false);
	assert.equal(streams, null);
	assert.ok(activity.exertion > 0, 'but it still scores — the cascade has a floor for exactly this');
	assert.equal(activity.local_date, '2026-03-02');

	// A track of (0,0) pairs is a broken GPS fix, not a trip to the Gulf of Guinea.
	const nullIsland = toRows(
		{ ...poolSwim, sport: 'ride', streams: { latlng: [[0, 0], [0, 0]], time_s: [0, 1] } },
		TH,
	);
	assert.equal(nullIsland.activity.route_path, null, '(0,0) fixes must not become a route');
}

// ---------------------------------------------------------------------------
// 8. Stream decimation keeps the arrays parallel
// ---------------------------------------------------------------------------
//
// Storing every sample would need more space than the database is allowed, so
// streams are decimated on the way in. The failure this guards against is
// silent and total: if two arrays are indexed differently, sample N is a
// different instant in each, and every chart on the detail page is subtly
// wrong with nothing to show for it.
{
	const n = 5000;
	const withStreams = {
		sport: 'ride',
		started_at: '2026-05-01T14:00:00.000Z',
		utc_offset_minutes: -420,
		elapsed_seconds: n,
		moving_seconds: n,
		distance_m: 50000,
		streams: {
			time_s: Array.from({ length: n }, (_, i) => i),
			power_w: Array.from({ length: n }, (_, i) => 200 + (i % 7)),
			heartrate: Array.from({ length: n }, (_, i) => 140 + (i % 5)),
			latlng: Array.from({ length: n }, (_, i) => [47 + i / 1e5, -122 + i / 1e5]),
			moving: Array.from({ length: n }, () => true),
		},
	};

	const { activity, streams } = toRows(withStreams, TH);

	assert.equal(streams.sample_count, MAX_STORED_SAMPLES, 'a long stream is decimated to the cap');
	for (const key of ['time_s', 'power_w', 'heartrate', 'latlng', 'moving']) {
		assert.equal(streams[key].length, MAX_STORED_SAMPLES, `${key} must be decimated to the same length`);
	}

	// The parallel-index property, checked against a value that encodes its own
	// original position: time_s[k] IS the original index.
	for (const k of [0, 1, 500, MAX_STORED_SAMPLES - 1]) {
		const original = streams.time_s[k];
		assert.equal(streams.power_w[k], 200 + (original % 7), `power_w[${k}] came from a different sample than time_s[${k}]`);
		assert.equal(streams.heartrate[k], 140 + (original % 5), `heartrate[${k}] is out of step`);
		assert.ok(Math.abs(streams.latlng[k][0] - (47 + original / 1e5)) < 1e-9, `latlng[${k}] is out of step`);
	}
	assert.equal(streams.time_s[0], 0, 'the first sample is kept');
	assert.equal(streams.time_s[MAX_STORED_SAMPLES - 1], n - 1, 'and so is the last');

	// Exertion is computed before decimation, so a power file still scores off
	// the full-resolution stream.
	assert.equal(activity.exertion_method, 'tss');
	assert.equal(activity.exertion_confidence, 'measured');

	// A short stream is left exactly as it is.
	const short = toRows(
		{ ...withStreams, streams: { time_s: [0, 1, 2], heartrate: [130, 131, 132] } },
		TH,
	);
	assert.equal(short.streams.sample_count, 3, 'a stream under the cap is stored whole');
	assert.deepEqual(short.streams.heartrate, [130, 131, 132]);
}

// ---------------------------------------------------------------------------
// 9. Real files, when an export is at hand
// ---------------------------------------------------------------------------

const archive = process.argv[2];
if (!archive || !existsSync(join(archive, 'activities.csv'))) {
	console.log('ingest: ok (file-parsing checks skipped — pass a Strava export directory to include them)');
	process.exit(0);
}

{
	const rows = parseCsv(readFileSync(join(archive, 'activities.csv'), 'utf8'));
	const idx = indexHeader(rows[0]);
	const parsed = rows.slice(1).map((c) => readRow(c, idx)).filter(Boolean);
	assert.ok(parsed.length > 100, 'the export should hold a real history');

	// Every type in the export must map. This is the check that catches a new
	// sport variant appearing in a future export.
	const unknown = new Set();
	for (const row of parsed) {
		try {
			sportFromStrava(row.type);
		} catch {
			unknown.add(row.type);
		}
	}
	assert.equal(unknown.size, 0, `unmapped activity types in the export: ${[...unknown].join(', ')}`);

	// One of each file format, parsed end to end.
	const seen = { fit: false, gpx: false, tcx: false };
	for (const row of parsed) {
		if (!row.filename) continue;
		const name = row.filename.toLowerCase().replace(/\.gz$/, '');
		const kind = name.endsWith('.fit') ? 'fit' : name.endsWith('.gpx') ? 'gpx' : name.endsWith('.tcx') ? 'tcx' : null;
		if (!kind || seen[kind]) continue;
		const full = join(archive, row.filename);
		if (!existsSync(full)) continue;

		const raw = readFileSync(full);
		const buf = row.filename.endsWith('.gz') ? gunzipSync(raw) : raw;
		const sport = sportFromStrava(row.type);
		const canonical =
			kind === 'fit'
				? parseFit(buf, { sport })
				: kind === 'gpx'
					? parseGpx(buf.toString('utf8'), { sport })
					: parseTcx(buf.toString('utf8'), { sport });
		if (!canonical) continue;
		seen[kind] = true;

		assert.ok(Date.parse(canonical.started_at) > 0, `${kind}: needs a real start instant`);
		assert.ok(canonical.elapsed_seconds > 0, `${kind}: needs a duration`);

		const { activity } = toRows(canonical, TH);
		assert.match(activity.local_date, /^\d{4}-\d{2}-\d{2}$/, `${kind}: local_date must be a date`);
		assert.ok(activity.exertion >= 0, `${kind}: exertion must be a number`);
		if (activity.route_path) {
			assert.match(activity.route_path, /^M[\d.\-\s]/, `${kind}: route_path must be an SVG path`);
			// §7: the path is fitted to a 0 0 100 100 viewBox with 6 units of padding.
			const coords = activity.route_path.match(/-?\d+(\.\d+)?/g).map(Number);
			assert.ok(Math.min(...coords) >= 0 && Math.max(...coords) <= 100, `${kind}: route_path escapes its viewBox`);
		}
	}

	for (const [kind, ok] of Object.entries(seen)) {
		if (!ok) console.log(`  (no parseable ${kind} file found in this export — check skipped)`);
	}
}

console.log('ingest: ok');
