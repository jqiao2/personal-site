// Bring a Beli export (tmp/beli.json, from export-beli.mjs) into the log.
//
// Two lists, two destinations, decided with the owner:
//   been  -> a `restaurants` row plus one `restaurant_visits` row, so the place
//            counts as visited. Beli's 0-10 score is kept verbatim in
//            `restaurants.beli_score` (0052); the visit's star rating is a lossy
//            guess derived from it. No verdict — that ladder is the owner's own.
//   want  -> a `restaurants` row with `to_try_added_at` set: the to-try list.
//
// SKIP, NEVER OVERWRITE. A place already in the log — matched by Google place id,
// or failing that by name+city — is left exactly as it is. This backfills what
// is missing; it does not touch what was entered by hand. A place that is both
// ranked and bookmarked on Beli lands as visited (been is processed first).
//
// Usage:
//   node scripts/import-beli.mjs            # dry run: says what it would add
//   node --env-file=.env scripts/import-beli.mjs --commit   # write
//
// Only --commit needs credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const commit = process.argv.includes('--commit');
const selfTest = process.argv.includes('--selftest');

// ---------------------------------------------------------------------------
// Pure mapping — Beli's shapes to this schema's
// ---------------------------------------------------------------------------

/** Lower-cased, unaccented, unpunctuated — the form two names/cities compare in. */
function normalise(s) {
	return (s ?? '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** "New York, NY" -> {city:"New York", state:"NY"}; "London" -> {city:"London", state:null}. */
export function splitCity(raw) {
	const s = (raw ?? '').trim();
	const m = s.match(/^(.*),\s*([A-Z]{2})$/); // a trailing 2-letter state/province code
	return m ? { city: m[1].trim(), state: m[2] } : { city: s, state: null };
}

/** Beli's price 1-4 (or null) -> the '$'..'$$$$' band. */
export function priceBand(price) {
	return price >= 1 && price <= 4 ? '$'.repeat(price) : null;
}

/** Beli's 0-10 score -> a 0.5-5 star rating, the closest this schema can hold. */
export function starRating(score) {
	if (score == null) return null;
	const stars = Math.round(score) / 2; // score/2 to the nearest half star
	return Math.min(5, Math.max(0.5, stars));
}

const COUNTRY = {
	'United States': 'US', Canada: 'CA', 'United Kingdom': 'GB', Mexico: 'MX', Spain: 'ES',
	Greece: 'GR', Australia: 'AU', Belize: 'BZ', Bermuda: 'BM', Qatar: 'QA', India: 'IN',
	France: 'FR', Italy: 'IT', Germany: 'DE', Japan: 'JP', Portugal: 'PT', Ireland: 'IE',
};
export function countryCode(name) {
	if (!name) return 'US';
	return COUNTRY[name] ?? (name.length === 2 ? name.toUpperCase() : name);
}

/** The common columns both lists fill on a `restaurants` row. */
function placeRow(p) {
	const { city, state } = splitCity(p.city);
	return {
		name: p.name,
		cuisines: p.cuisines ?? [],
		price_band: priceBand(p.price),
		neighborhood: p.neighborhood ?? null,
		city,
		state_region: state,
		country: countryCode(p.country),
		lat: p.lat ?? null,
		lng: p.lng ?? null,
		google_place_id: p.google_place_id ?? null,
		website_url: p.website ?? null,
	};
}

/** The key a place is deduplicated on: its Google id, or failing that name+city. */
function dedupeKeys(p) {
	const keys = [];
	if (p.google_place_id) keys.push(`g:${p.google_place_id.toLowerCase()}`);
	const { city } = splitCity(p.city);
	keys.push(`n:${normalise(p.name)}|${normalise(city)}`);
	return keys;
}

if (selfTest) {
	const assert = (await import('node:assert/strict')).default;
	assert.deepEqual(splitCity('Tarrytown, NY'), { city: 'Tarrytown', state: 'NY' });
	assert.deepEqual(splitCity('Montreal, QC'), { city: 'Montreal', state: 'QC' });
	assert.deepEqual(splitCity('London'), { city: 'London', state: null });
	assert.deepEqual(splitCity('Washington, D.C.'), { city: 'Washington, D.C.', state: null });
	assert.equal(priceBand(3), '$$$');
	assert.equal(priceBand(null), null);
	assert.equal(starRating(10), 5);
	assert.equal(starRating(9.34), 4.5);
	assert.equal(starRating(0.19), 0.5);
	assert.equal(countryCode('United Kingdom'), 'GB');
	assert.equal(countryCode('US'), 'US');
	console.log('ok — mappers pass');
	process.exit(0);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { been = [], want = [] } = JSON.parse(readFileSync('tmp/beli.json', 'utf8'));
console.log(`export: ${been.length} been, ${want.length} want to try`);

const url = process.env.SUPABASE_URL;
const key = commit ? process.env.SUPABASE_SERVICE_ROLE_KEY : (process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY);
if (commit && (!url || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to --commit');
	process.exit(1);
}
if (!url || !key) {
	console.error('SUPABASE_URL and a key must be set (anon is enough for a dry run)');
	process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// What is already on record, so nothing here is added twice. Read whole — the
// table is small and public — and index by every key a place could match on.
const { data: existing, error: readErr } = await db.from('restaurants').select('name, city, google_place_id');
if (readErr) {
	console.error('could not read existing restaurants:', readErr.message);
	process.exit(1);
}
const seen = new Set();
for (const r of existing ?? []) {
	if (r.google_place_id) seen.add(`g:${r.google_place_id.toLowerCase()}`);
	seen.add(`n:${normalise(r.name)}|${normalise(r.city)}`);
}
console.log(`on record: ${existing?.length ?? 0} places`);

/** True if the place is already known, by any of its keys. Records it as known. */
function claim(p) {
	const keys = dedupeKeys(p);
	if (keys.some((k) => seen.has(k))) return false;
	for (const k of keys) seen.add(k);
	return true;
}

// been first, so a place that is both ranked and bookmarked lands as visited.
const newBeen = been.filter(claim);
const newWant = want.filter(claim);
const skipped = been.length + want.length - newBeen.length - newWant.length;
console.log(`to add: ${newBeen.length} been, ${newWant.length} want to try  (${skipped} already on record)`);

const sample = (rows, kind) => {
	for (const p of rows.slice(0, 4)) {
		const { city, state } = splitCity(p.city);
		const extra = kind === 'been' ? `beli ${p.score} -> ${starRating(p.score)}★ on ${p.visit_dates?.[0] ?? (p.ranked_on ?? '').slice(0, 10)}` : `to try`;
		console.log(`  ${p.name.slice(0, 32).padEnd(32)} ${[city, state].filter(Boolean).join(', ').padEnd(20)} ${extra}`);
	}
};
sample(newBeen, 'been');
sample(newWant, 'want');

if (!commit) {
	console.log('\ndry run — nothing written. re-run with --commit.');
	process.exit(0);
}

// --- write ----------------------------------------------------------------
// Insert the places, then the visits. Places come back with their new ids from
// the same insert (returning the row), keyed to build the visit rows.
async function insertPlaces(rows, extra) {
	const out = [];
	const CHUNK = 200;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const slice = rows.slice(i, i + CHUNK).map(extra);
		const { data, error } = await db.from('restaurants').insert(slice).select('id, google_place_id, name');
		if (error) throw new Error(`restaurants insert failed at ${i}: ${error.message}`);
		out.push(...data);
	}
	return out;
}

// want -> to-try places
if (newWant.length) {
	await insertPlaces(newWant, (p) => ({ ...placeRow(p), to_try_added_at: p.bookmarked_on ?? new Date().toISOString() }));
	console.log(`added ${newWant.length} to-try places`);
}

// been -> places (with beli_score) + one visit each
if (newBeen.length) {
	const placed = await insertPlaces(newBeen, (p) => ({ ...placeRow(p), beli_score: p.score == null ? null : Math.round(p.score * 100) / 100 }));
	// Match the returned ids back to their source rows to build visits.
	const idByKey = new Map();
	for (const r of placed) {
		if (r.google_place_id) idByKey.set(`g:${r.google_place_id.toLowerCase()}`, r.id);
		idByKey.set(`n:${normalise(r.name)}`, r.id);
	}
	const visits = newBeen
		.map((p) => {
			const id = (p.google_place_id && idByKey.get(`g:${p.google_place_id.toLowerCase()}`)) ?? idByKey.get(`n:${normalise(p.name)}`);
			if (!id) return null;
			const visitedOn = p.visit_dates?.[0] ?? ((p.ranked_on ?? '').slice(0, 10) || null);
			return { restaurant_id: id, visited_on: visitedOn, rating: starRating(p.score) };
		})
		.filter((v) => v && v.visited_on);
	const CHUNK = 200;
	for (let i = 0; i < visits.length; i += CHUNK) {
		const { error } = await db.from('restaurant_visits').insert(visits.slice(i, i + CHUNK));
		if (error) throw new Error(`visits insert failed at ${i}: ${error.message}`);
	}
	console.log(`added ${newBeen.length} visited places and ${visits.length} visits`);
}

console.log('\ndone.');
