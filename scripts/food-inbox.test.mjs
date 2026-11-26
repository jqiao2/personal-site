import assert from 'node:assert/strict';
import { boxAround, groupMeals, meters } from '../src/lib/food-inbox-group.ts';

const photo = (id, takenAt, lat = null, lng = null) => ({ id, url: '', width: 1, height: 1, takenAt, lat, lng });

const summary = (photos) => groupMeals(photos).map((m) => [m.day, m.photos.map((p) => p.id)]);

// One meal, out of order, one photograph without a fix.
assert.deepEqual(
	summary([photo(2, '2026-11-01T19:40:00'), photo(1, '2026-11-01T19:00:00', 40.75, -73.99)]),
	[['2026-11-01', [1, 2]]],
);

// Newest first; a long gap splits.
assert.deepEqual(
	summary([photo(1, '2026-11-01T12:00:00'), photo(2, '2026-11-01T19:00:00')]),
	[['2026-11-01', [2]], ['2026-11-01', [1]]],
);

// Dinner then dessert around the corner a few minutes later: two places.
assert.equal(groupMeals([photo(1, '2026-11-01T20:00:00', 40.75, -73.99), photo(2, '2026-11-01T20:30:00', 40.76, -73.99)]).length, 2);

// Past midnight stays with the evening it began.
assert.deepEqual(summary([photo(1, '2026-11-01T23:50:00'), photo(2, '2026-11-02T00:20:00')]), [['2026-11-01', [1, 2]]]);

const here = { lat: 40.75, lng: -73.99 };

const box = boxAround(here, 150);

assert.ok(Math.abs(meters(here, { lat: box.north, lng: here.lng }) - 150) < 2);

assert.ok(Math.abs(meters(here, { lat: here.lat, lng: box.east }) - 150) < 2);

console.log('food inbox: ok');
