// The flight poster's settings form, stored-config defaults and sync body check.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/flight-poster.test.mjs
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, adminView, parseConfigForm, posterConfig, syncBody } from '../src/lib/flight-poster.ts';

const FIELDS = {
	lat: '40.75',
	lon: '-74',
	radius_nm: '25',
	start: '07:00',
	end: '23:00',
	poll_minutes: '5',
	min_hold_minutes: '60',
	min_altitude_ft: '1500',
	drop_categories: 'a1, a7  B1',
	exclude_callsign_prefixes: 'EJA,LXJ',
	distance_exponent: '1.5',
	min_distance_km: '150',
	airline_callsigns_only: 'on',
};

const form = (o = {}) => {
	const f = new FormData();

	for (const [k, v] of Object.entries({ ...FIELDS, ...o })) if (v !== null) f.set(k, v);

	return parseConfigForm(f);
};

// A full form round-trips into the board's config.json shape.
const { config } = form();

assert.deepEqual(config.home, { lat: 40.75, lon: -74, radius_nm: 25 });

assert.deepEqual(config.filter.drop_categories, ['A1', 'A7', 'B1']);

assert.equal(config.filter.airline_callsigns_only, true);

assert.equal(config.selection.prefer_cities_with_posters, false); // unchecked box is absent

assert.equal(config.selection.distance_exponent, 1.5);

// Bad fields are named, not saved.
assert.match(form({ lat: '91' }).error, /lat/);

assert.match(form({ poll_minutes: '0' }).error, /poll_minutes/);

assert.match(form({ start: '7am' }).error, /HH:MM/);

assert.match(form({ radius_nm: null }).error, /radius_nm/);

assert.match(form({ lon: '' }).error, /lon/);

// A stored config fills in defaults one field at a time.
const merged = posterConfig.parse({ home: { radius_nm: 10 }, poll_minutes: 3 });

assert.deepEqual(merged.home, { ...DEFAULT_CONFIG.home, radius_nm: 10 });

assert.equal(merged.poll_minutes, 3);

assert.equal(merged.min_hold_minutes, 60);

assert.deepEqual(posterConfig.parse({}), DEFAULT_CONFIG);

// Sync body: needs a status object and a city array; junk cities dropped.
assert.equal(syncBody.safeParse(null).success, false);

assert.equal(syncBody.safeParse({ status: {} }).success, false);

const body = syncBody.parse({ status: { firmware: '1.0', extra: 1 }, cities: [{ slug: 'london', name: 'London', x: 1 }, { slug: 2 }] });

assert.deepEqual(body.cities, [{ slug: 'london', name: 'London' }]);

assert.equal(body.status.extra, 1); // the whole status is kept for storage

// Online / offline / never.
const row = (synced_at, o = {}) => ({ config: DEFAULT_CONFIG, pending_show: null, status: null, cities: [], synced_at, ...o });

const now = Date.parse('2026-11-16T12:00:00Z');

assert.equal(adminView(row(null), now).unsetup, true);

assert.equal(adminView(row('2026-11-16T11:55:00Z'), now).offline, false);

assert.equal(adminView(row('2026-11-16T11:30:00Z'), now).offline, true); // > 3 polls of 5 min

// The current and queued cities are marked in the library.
const v = adminView(
	row('2026-11-16T11:59:00Z', {
		pending_show: 'tokyo',
		status: { current: { slug: 'london', name: 'London', shown_at: 1763290000 } },
		cities: [
			{ slug: 'london', name: 'London' },
			{ slug: 'tokyo', name: 'Tokyo' },
		],
	}),
	now,
);

assert.deepEqual(
	v.cities.map((x) => [x.slug, x.current, x.pending]),
	[
		['london', true, false],
		['tokyo', false, true],
	],
);

assert.equal(v.pending, 'Tokyo');

console.log('flight-poster: ok');
