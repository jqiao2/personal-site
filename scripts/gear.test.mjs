// The one runnable check on the gear pages' only real logic: the date-windowed
// sum and the wear status it feeds. Everything else on those pages is markup.
//
//   node --import ./scripts/ts-hook.mjs scripts/gear.test.mjs
//
// Same shape as scripts/ingest.test.mjs — plain asserts, no framework.
import assert from 'node:assert/strict';
import { sumRides, wearOf, daysBetween, ageText, parseInterval, effectiveMeta } from '../src/lib/gear-wear.ts';

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
	life_miles: null,
	life_months: null,
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

// --- per-instance overrides (0037) ------------------------------------------
// The same 4,100 miles that make a default chain overdue leave a chain given a
// 5,000–10,000 window merely "ok". The override REPLACES the axis; it does not
// add to it.
const wide = wearOf(component({ life_miles: [5000, 10000] }), rides, '2025-12-31');
assert.equal(Math.round(wide.miles), 4100, 'the miles are the same miles');
assert.equal(wide.status, 'ok');
assert.ok(wide.fraction < 0.5);
const narrow = wearOf(component({ life_miles: [500, 1000] }), rides, '2025-12-31');
assert.equal(narrow.status, 'overdue');

// An override on an axis the kind doesn't have gives the part that axis — the
// point of an override is that the category was wrong about this instance.
const datedChain = wearOf(component({ life_months: [1, 2] }), rides, '2025-12-31');
assert.equal(datedChain.meta.lifeMonths[0], 1);
assert.equal(datedChain.meta.lifeMiles[1], 4000, 'the untouched axis keeps its default');
assert.equal(datedChain.status, 'overdue');

// A bottom bracket has no default axis at all; an override gives it one, so it
// stops being 'monitor' and starts having a bar.
const bbDefault = wearOf(component({ kind: 'bottom_bracket' }), rides, '2025-12-31');
assert.equal(bbDefault.fraction, null);
const bbOverride = wearOf(component({ kind: 'bottom_bracket', life_miles: [3000, 6000] }), rides, '2025-12-31');
assert.equal(bbOverride.status, 'due');
assert.ok(bbOverride.fraction > 0);

// effectiveMeta returns the untouched default object when there's no override,
// so nothing downstream can mutate COMPONENT_KINDS through a copy.
assert.equal(effectiveMeta(component({})).lifeMiles[1], 4000);

// --- parseInterval: an unparseable window must never become a window --------
assert.deepEqual(parseInterval('2500-5000 mi'), { axis: 'miles', window: [2500, 5000] });
assert.deepEqual(parseInterval('  4 – 8 mo '), { axis: 'months', window: [4, 8] });
assert.deepEqual(parseInterval('3-6 months'), { axis: 'months', window: [3, 6] });
assert.deepEqual(parseInterval('1000-2000 MILES'), { axis: 'miles', window: [1000, 2000] });
assert.equal(parseInterval('5000-2000 mi'), null, 'reversed window is refused');
assert.equal(parseInterval('0-2000 mi'), null, 'a zero end is refused');
assert.equal(parseInterval('2500 mi'), null, 'a single threshold is not a window');
assert.equal(parseInterval('2500-5000'), null, 'no unit means no axis');
assert.equal(parseInterval('2500-5000 km'), null, 'km is not an axis this site has');
assert.equal(parseInterval(''), null);

// --- the two date helpers ---------------------------------------------------
assert.equal(daysBetween('2025-01-01', '2025-01-02'), 1);
assert.equal(daysBetween('2025-03-08', '2025-03-10'), 2, 'DST must not eat a day');
assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, 'leap day counts');
assert.equal(ageText(1), '1 day');
assert.equal(ageText(45), '45 days');
assert.equal(ageText(365), '12 mo');
assert.equal(ageText(1000), '2.7 yr');

console.log('gear.test.mjs: ok');
