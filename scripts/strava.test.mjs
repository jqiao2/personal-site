// The Strava API → canonical mapping, checked against a hand-built detailed
// activity + streams object shaped like Strava's. DB-free on purpose (the
// mapper touches no database), so it runs in CI without credentials.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/strava.test.mjs

import assert from 'node:assert/strict';
import { activityToCanonical } from '../src/lib/ingest/providers/strava.ts';
import { toRows } from '../src/lib/ingest/canonical.ts';

const NO_TH = {
	ftp_w: null, lthr_bpm: null, max_hr: null, rest_hr: null,
	threshold_pace_s_per_km: null, css_pace_s_per_100m: null, weight_kg: null,
};

// A gravel ride with a GPS track, HR and power.
const activity = {
	id: 987654321,
	name: 'Cutthroat shakedown',
	description: 'first ride on the new tyres',
	type: 'Ride',
	sport_type: 'GravelRide',
	start_date: '2026-08-20T15:00:00Z',
	utc_offset: -25200, // -7h → -420 min
	timezone: '(GMT-08:00) America/Los_Angeles',
	elapsed_time: 3900,
	moving_time: 3600,
	distance: 30000,
	total_elevation_gain: 450,
	average_speed: 8.33,
	average_heartrate: 150,
	average_watts: 200,
	weighted_average_watts: 210,
	device_name: 'Wahoo ELEMNT',
	gear_id: 'b1234567',
	laps: [{ lap_index: 1, elapsed_time: 3900, distance: 30000, average_heartrate: 150 }],
};

const streams = {
	time: { data: [0, 1, 2] },
	latlng: { data: [[47.6, -122.3], [47.601, -122.301], [47.602, -122.302]] },
	altitude: { data: [100, 101, 103] },
	heartrate: { data: [140, 150, 160] },
	watts: { data: [180, 200, 220] },
	velocity_smooth: { data: [8, 8.3, 8.6] },
	moving: { data: [true, true, true] },
};

const c = activityToCanonical(activity, streams);

// Sport comes from sport_type (the finer field), not type=Ride.
assert.equal(c.sport, 'gravel_ride', 'sport_type GravelRide → gravel_ride');
assert.equal(c.title, 'Cutthroat shakedown');
assert.equal(c.notes, 'first ride on the new tyres');
assert.equal(c.utc_offset_minutes, -420, 'utc_offset seconds → minutes');
assert.equal(c.timezone, 'America/Los_Angeles', 'IANA name pulled out of Strava tz string');
assert.equal(c.elapsed_seconds, 3900);
assert.equal(c.moving_seconds, 3600);
assert.equal(c.distance_m, 30000);
assert.equal(c.normalized_power_w, 210, 'weighted_average_watts → normalized_power_w');
assert.equal(c.device_name, 'Wahoo ELEMNT');
assert.equal(c.laps?.length, 1);
assert.deepEqual(c.streams?.latlng?.[0], [47.6, -122.3]);
assert.equal(c.streams?.power_w?.[2], 220, 'watts stream → power_w');
assert.equal(c.streams?.speed_ms?.[1], 8.3, 'velocity_smooth → speed_ms');
assert.ok(!('grade' in (c.streams ?? {})), 'absent stream key is dropped, not left empty');

// toRows derives local_date from the offset: 15:00Z at -7h is 08:00 local, so
// the ride lands on the 20th, not the 21st.
const { activity: row } = toRows(c, NO_TH);
assert.equal(row.local_date, '2026-08-20', 'local_date uses the utc_offset, not UTC midnight');
assert.equal(row.sport, 'gravel_ride');
assert.ok(row.route_path, 'a GPS track produces a route_path');

// An indoor ride with no GPS maps with no geometry — a normal reading.
const indoor = activityToCanonical(
	{ id: 1, type: 'VirtualRide', sport_type: 'VirtualRide', start_date: '2026-08-20T02:00:00Z', elapsed_time: 3600 },
	{ time: { data: [0, 1] }, watts: { data: [200, 210] } },
);
assert.equal(indoor.sport, 'virtual_ride');
assert.equal(indoor.streams?.latlng, undefined, 'no latlng stream on a trainer ride');
const { activity: indoorRow } = toRows(indoor, NO_TH);
assert.equal(indoorRow.route_path, null, 'no route without a track');

// An unmapped sport throws rather than filing as "other".
assert.throws(
	() => activityToCanonical({ id: 2, sport_type: 'Pickleball', start_date: '2026-08-20T02:00:00Z', elapsed_time: 60 }),
	/Unknown activity type/,
	'unknown sport_type throws UnknownSportError',
);

console.log('strava mapping: all assertions passed');
