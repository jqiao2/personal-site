// The two pieces of arithmetic-or-mapping that 0033 leans on, checked offline.
//
// Neither of these fails loudly. A tier mapped to the wrong column produces a
// place that reads almost right — "Sunset Park, New York" instead of
// "Sunset Park, Brooklyn" — and a plus code decoded a cell off puts a pin on
// the next building along. Both look fine and are wrong, which is exactly the
// kind of thing worth one assert each.
//
//   node scripts/check-place-location.mjs
//
// No network, no database, no framework. Exits non-zero on the first failure.
import assert from 'node:assert/strict';
import { splitAddress } from '../src/lib/geocode.ts';
import { encode, decodePlusCode, isFullPlusCode, recoverPlusCode } from '../src/lib/plus-code.ts';

let checks = 0;
const ok = (label, fn) => {
	fn();
	checks += 1;
	console.log(`  ok  ${label}`);
};

// ---------------------------------------------------------------------------
// The tiers
// ---------------------------------------------------------------------------
// COPIED VERBATIM from what Nominatim returns for 40.6452,-74.0102, because
// the thing it teaches is not what the documentation says: there is no
// `city_district` here, the borough is in `suburb`, and `city` is "New York".
const sunsetPark = {
	shop: 'Angel Nail',
	house_number: '4925',
	road: '5th Avenue',
	neighbourhood: 'Sunset Park',
	suburb: 'Brooklyn',
	county: 'Kings County',
	city: 'New York',
	state: 'New York',
	'ISO3166-2-lvl4': 'US-NY',
	postcode: '11220',
	country: 'United States',
	country_code: 'us',
};

ok('in New York the borough comes off suburb, and the city stays New York', () => {
	const p = splitAddress(sunsetPark);
	assert.equal(p.neighborhood, 'Sunset Park');
	assert.equal(p.borough, 'Brooklyn');
	assert.equal(p.city, 'New York');
});

ok('county is never mistaken for the city', () => {
	// "Kings County" is a real fact about Brooklyn and not a field this log has.
	const p = splitAddress(sunsetPark);
	assert.notEqual(p.city, 'Kings County');
	assert.notEqual(p.borough, 'Kings County');
});

ok('a lone suburb is the neighbourhood, not a borough', () => {
	// The reading everywhere outside a boroughed city: one tier, so it is the
	// finest one, and there is no second tier to invent.
	const p = splitAddress({ suburb: 'Fitzroy', city: 'Melbourne', country_code: 'au' });
	assert.equal(p.neighborhood, 'Fitzroy');
	assert.equal(p.borough, null, 'a single tier was promoted into two');
});

ok('city_district still wins where a mapper used it', () => {
	const p = splitAddress({ neighbourhood: 'Shoreditch', city_district: 'Hackney', city: 'London', country_code: 'gb' });
	assert.equal(p.neighborhood, 'Shoreditch');
	assert.equal(p.borough, 'Hackney');
});

ok('the street splits into two fields', () => {
	const p = splitAddress(sunsetPark);
	assert.equal(p.houseNumber, '4925');
	assert.equal(p.road, '5th Avenue');
});

ok('country is ISO alpha-2, upper-cased', () => {
	assert.equal(splitAddress(sunsetPark).country, 'US');
});

// The regression this whole migration exists for: a quarter must NOT be able to
// arrive labelled a neighbourhood.
ok('a quarter stays a quarter and does not become the neighbourhood', () => {
	const p = splitAddress({ quarter: 'Shinjuku', city: 'Tokyo', country_code: 'jp' });
	assert.equal(p.quarter, 'Shinjuku');
	assert.equal(p.neighborhood, null, 'quarter leaked into neighborhood — the old ?? chain is back');
});

ok('a place with neither borough nor quarter reports null, not a guess', () => {
	const p = splitAddress({ city: 'Austin', state: 'Texas', country_code: 'us' });
	assert.equal(p.borough, null);
	assert.equal(p.quarter, null);
	assert.equal(p.neighborhood, null);
	assert.equal(p.stateRegion, 'Texas');
});

ok('within-tier fallbacks still work (town is a city, province is a state)', () => {
	const p = splitAddress({ town: 'Beacon', province: 'Ontario', country_code: 'ca' });
	assert.equal(p.city, 'Beacon');
	assert.equal(p.stateRegion, 'Ontario');
});

// ---------------------------------------------------------------------------
// The plus codes
// ---------------------------------------------------------------------------
// `encode` is newly exported because the code is DERIVED rather than stored, so
// it is now the only thing standing between a point and the code shown for it.

ok('a known point encodes to its published code', () => {
	// The Google campus, the reference implementation's own example.
	assert.equal(encode(37.4223, -122.0841).slice(0, 8), '849VCWC8');
});

ok('encode then decode returns the point, within the cell', () => {
	for (const [lat, lng] of [
		[40.6452, -74.0102], // Sunset Park
		[35.6895, 139.6917], // Tokyo
		[-33.8688, 151.2093], // Sydney, southern + eastern
		[-22.9068, -43.1729], // Rio, both negative
		[0, 0],
	]) {
		const code = encode(lat, lng);
		assert.ok(isFullPlusCode(code), `${code} is not a full code`);
		const back = decodePlusCode(code);
		// A 10-character code is about 14 metres; 0.0002° is comfortably outside
		// the cell, so this catches a grid mix-up without being flaky.
		assert.ok(Math.abs(back.lat - lat) < 0.0002, `lat drifted at ${lat},${lng}`);
		assert.ok(Math.abs(back.lng - lng) < 0.0002, `lng drifted at ${lat},${lng}`);
	}
});

ok('a short code recovers against a nearby reference', () => {
	const full = encode(40.6452, -74.0102);
	const short = full.slice(4);
	// Somewhere in Brooklyn, a few km off — what a locality name would resolve to.
	const recovered = recoverPlusCode(short, 40.6782, -73.9442);
	assert.equal(recovered, full);
});

console.log(`\n${checks} checks passed.`);
