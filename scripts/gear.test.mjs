// The one runnable check on the gear pages' only real logic: the date-windowed
// sum and the wear status it feeds. Everything else on those pages is markup.
//
//   node --import ./scripts/ts-hook.mjs scripts/gear.test.mjs
//
// Same shape as scripts/ingest.test.mjs — plain asserts, no framework.
import assert from 'node:assert/strict';
import { sumRides, wearOf, daysBetween, ageText } from '../src/lib/gear-wear.ts';

const MI = 1609.344;
const ride = (local_date, miles) => ({
	local_date,
	distance_m: miles * MI,
	moving_seconds: miles * 200,
	elevation_gain_m: 0,
});

// A year of rides, one per quarter.
const rides = [
	ride('2025-01-10', 500),
	ride('2025-04-10', 900),
	ride('2025-07-10', 1200),
	ride('2025-10-10', 1500),
];

// --- sumRides: the window is inclusive at both ends -------------------------
assert.equal(sumRides(rides).activityCount, 4);
assert.equal(Math.round(sumRides(rides).distanceM / MI), 4100);
assert.equal(sumRides(rides, '2025-04-10', '2025-07-10').activityCount, 2, 'both bounds inclusive');
assert.equal(Math.round(sumRides(rides, '2025-04-10', '2025-07-10').distanceM / MI), 2100);
assert.equal(sumRides(rides, '2025-11-01').activityCount, 0, 'window past every ride is empty');
assert.equal(sumRides(rides).firstDate, '2025-01-10');
assert.equal(sumRides(rides).lastDate, '2025-10-10');

// --- wearOf: miles are counted from the fitted date, not from the odometer ---
const component = (over) => ({
	id: 1,
	gear_id: 1,
	kind: 'chain',
	label: null,
	installed_on: '2025-01-01',
	removed_on: null,
	baseline_distance_m: 0,
	condition: null,
	notes: null,
	created_at: '',
	updated_at: '',
	...over,
});

// Chain fitted mid-year sees only the rides after it: 1200 + 1500 = 2700,
// which is inside the 2,000–4,000 window → due, not overdue.
const midYear = wearOf(component({ installed_on: '2025-06-01' }), rides, '2025-12-31');
assert.equal(Math.round(midYear.miles), 2700);
assert.equal(midYear.rides, 2);
assert.equal(midYear.status, 'due');

// A chain fitted at the start has all 4,100 — past the far end → overdue.
const fromStart = wearOf(component({}), rides, '2025-12-31');
assert.equal(Math.round(fromStart.miles), 4100);
assert.equal(fromStart.status, 'overdue');
assert.ok(fromStart.fraction > 1);

// Baseline miles are miles: a chain that arrived with 1,900 on it is overdue
// after a single 1,500-mile quarter, even though this bike only saw 1,500.
const carried = wearOf(
	component({ installed_on: '2025-10-01', baseline_distance_m: 1900 * MI }),
	rides,
	'2025-12-31',
);
assert.equal(Math.round(carried.miles), 3400);
assert.equal(carried.status, 'due');

// A removed part freezes at its removal date — later rides don't age it.
const removed = wearOf(component({ removed_on: '2025-05-01' }), rides, '2025-12-31');
assert.equal(Math.round(removed.miles), 1400, 'only the rides inside its own window');
assert.equal(removed.status, 'retired');

// Condition-only parts get no fraction rather than a fabricated one.
const bb = wearOf(component({ kind: 'bottom_bracket' }), rides, '2025-12-31');
assert.equal(bb.fraction, null);
assert.equal(bb.status, 'monitor');

// Sealant has no mileage axis at all — it ages purely on the calendar.
const sealantFresh = wearOf(component({ kind: 'sealant', installed_on: '2025-12-01' }), rides, '2025-12-31');
assert.equal(sealantFresh.status, 'ok');
const sealantOld = wearOf(component({ kind: 'sealant', installed_on: '2025-01-01' }), rides, '2025-12-31');
assert.equal(sealantOld.status, 'overdue', 'a year-old sealant is well past 3–6 months');

// --- the two date helpers ---------------------------------------------------
assert.equal(daysBetween('2025-01-01', '2025-01-02'), 1);
assert.equal(daysBetween('2025-03-08', '2025-03-10'), 2, 'DST must not eat a day');
assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, 'leap day counts');
assert.equal(ageText(1), '1 day');
assert.equal(ageText(45), '45 days');
assert.equal(ageText(365), '12 mo');
assert.equal(ageText(1000), '2.7 yr');

console.log('gear.test.mjs: ok');
