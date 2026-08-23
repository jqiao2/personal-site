// The one runnable check on the activity log's privacy rule. If this file
// passes and the pages still leak, the leak is a page that skipped the data
// layer — which is the only failure mode left by design.
//
//   node --import ./scripts/ts-hook.mjs scripts/privacy.test.mjs
//
// Same shape as scripts/gear.test.mjs — plain asserts, no framework. It imports
// src/lib/activity-privacy.ts, which is deliberately free of any database
// import so this can run with no .env and no network.
import assert from 'node:assert/strict';
import { redactActivities, visitorQuery } from '../src/lib/activity-privacy.ts';

const ride = (over = {}) => ({
	id: 7,
	sport: 'ride',
	sub_sport: 'gravel',
	parent_id: null,
	leg: null,
	title: 'Morning loop from the house',
	notes: 'legs felt good',
	started_at: '2026-03-04T14:02:11Z',
	local_date: '2026-03-04',
	elapsed_seconds: 7200,
	moving_seconds: 6800,
	distance_m: 52000,
	elevation_gain_m: 700,
	avg_hr: 142,
	avg_power_w: 210,
	exertion: 88,
	exertion_method: 'tss',
	exertion_confidence: 'measured',
	polyline: '_p~iF~ps|U_ulLnnqC',
	route_path: 'M 10 10 L 90 90',
	start_lat: 47.61,
	start_lng: -122.33,
	start_place: 'Ballard, Seattle',
	gear_id: 3,
	gear_name: 'Cervélo S3',
	gear_nickname: 'the road bike',
	favorite_rank: 1,
	has_streams: true,
	device_name: 'Wahoo ELEMNT',
	private: true,
	...over,
});

// --- The owner sees the row untouched --------------------------------------
{
	const [row] = redactActivities([ride()], true);
	assert.equal(row.title, 'Morning loop from the house');
	assert.equal(row.route_path, 'M 10 10 L 90 90');
	assert.equal(row.redacted, undefined, 'the owner never gets a redacted row');
}

// --- A visitor sees the sport and the day, and nothing else -----------------
{
	const [row] = redactActivities([ride()], false);
	assert.equal(row.redacted, true);
	assert.equal(row.sport, 'ride', 'the sport is the whole point of the card');
	assert.equal(row.local_date, '2026-03-04', 'the day is what puts it in the grid');
	assert.equal(row.title, '');
	assert.equal(row.elapsed_seconds, 0);

	// Everything else must be null. Asserted by walking the row rather than by
	// naming fields, so a column added to activity_list tomorrow is covered by
	// this test on the day it appears instead of the day someone remembers.
	const allowed = new Set(['id', 'sport', 'local_date', 'elapsed_seconds', 'title', 'has_streams', 'private', 'redacted']);
	for (const [key, value] of Object.entries(row)) {
		if (allowed.has(key)) continue;
		assert.equal(value, null, `${key} survived redaction`);
	}

	// The ones that would actually identify a person, called out by name so a
	// failure reads as what it is rather than as "some key survived".
	assert.equal(row.start_lat, null, 'a start point is a home address');
	assert.equal(row.route_path, null);
	assert.equal(row.polyline, null);
	assert.equal(row.start_place, null);
	assert.equal(row.started_at, null, 'the time of day says when the house is empty');
	assert.equal(row.notes, null);
	assert.equal(row.gear_nickname, null);
}

// --- Published activities pass through untouched ---------------------------
{
	const [row] = redactActivities([ride({ private: false })], false);
	assert.equal(row.redacted, undefined);
	assert.equal(row.title, 'Morning loop from the house', 'private=false is the opt-out');
}

// --- Fail closed: anything but an explicit false is private ----------------
for (const value of [undefined, null, true, 'false', 0]) {
	const [row] = redactActivities([ride({ private: value })], false);
	assert.equal(row.redacted, true, `private=${String(value)} must redact — only a real false publishes`);
}

// --- A mixed page redacts per row, not per page ----------------------------
{
	const rows = redactActivities([ride({ id: 1 }), ride({ id: 2, private: false }), ride({ id: 3 })], false);
	assert.deepEqual(rows.map((r) => Boolean(r.redacted)), [true, false, true]);
}

// --- visitorQuery: the filters are an oracle, so only two survive -----------
{
	const asked = {
		sports: ['ride'],
		dateFrom: '2026-01-01',
		dateTo: '2026-03-31',
		sortDir: 'asc',
		// Every one of these reads a private number by binary search.
		distanceMinM: 100000,
		distanceMaxM: 200000,
		durationMinS: 3600,
		durationMaxS: 7200,
		elevationMinM: 500,
		elevationMaxM: 1500,
		exertionMin: 50,
		exertionMax: 150,
		hasGps: true,
		gearIds: [3],
		indoor: false,
		hasPower: true,
		hasHr: true,
		place: 'Ballard',
		favoritesOnly: true,
		personalBestOnly: true,
		measuredOnly: true,
		sort: 'exertion',
		includeChildren: true,
	};
	const q = visitorQuery(asked);
	assert.deepEqual(q.sports, ['ride'], 'sport is on the card already');
	assert.equal(q.dateFrom, '2026-01-01', 'so is the day');
	assert.equal(q.dateTo, '2026-03-31');
	assert.equal(q.sort, 'date', 'a stat sort leaks the ordering with no filter set at all');
	for (const key of Object.keys(asked)) {
		if (['sports', 'dateFrom', 'dateTo', 'sortDir', 'sort'].includes(key)) continue;
		assert.equal(q[key], undefined, `${key} reached the query`);
	}
}

console.log('privacy.test.mjs: ok');
