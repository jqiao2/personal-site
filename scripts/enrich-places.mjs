// Fill in what a place is missing, from sources that can be kept.
//
// WHY THIS SOURCE AND NOT A NICER ONE. The obvious answer to "where is this
// restaurant" is Google Places, and it is the wrong answer here: its terms let
// you keep the place id and require everything else to be refreshed rather than
// stored, so building a local database on it means signing up to re-fetch it
// forever. Yelp and TripAdvisor say the same thing in different words. The
// point of this log is that it is a file you own, not a cache of somebody
// else's, so the sources it draws on are the ones whose data may simply be
// kept:
//
//   NYC DOHMH food-service establishments — every permitted restaurant, cart
//   and bakery in the five boroughs, with the health department's own geocode.
//   Public data, no key, no quota, no expiry. It is also the only source that
//   reliably has the places this list is made of: a Bangladeshi sweet shop in
//   Jackson Heights opened last spring is in here and in nothing else.
//
// The run is offline after the first fetch: the source is cached under .cache/
// and re-read from there, so re-running costs nothing and works on a plane.
// --refresh re-downloads it.
//
// WHAT IT WILL AND WILL NOT DECIDE. Every one of the places this is aimed at
// has a name and nothing else — no neighbourhood, no cuisine, no point — so the
// name is the only thing to match on, and a name alone is thin evidence. Two
// bars in this city are called The Canary. So the rule is deliberately mean:
//
//   1. Names are compared NORMALISED — accents folded, punctuation dropped,
//      and the noise words a saved list collects ("Restaurant", "NYC", the
//      borough someone appended) removed from both sides.
//   2. A match counts only if exactly one establishment answers to that name,
//      or if the several that do are the same address to within a block —
//      which is what a place with three inspection records looks like.
//   3. Anything else is reported and skipped. Not written, not guessed at.
//
// A skipped place is not a failure: it stays exactly as it was, which is a
// place with a name, and the dialog can place it by hand in ten seconds. A
// wrong coordinate is worse than a missing one, because nobody goes looking for
// it — it just quietly puts a pin on the wrong side of Queens.
//
// Existing values are never overwritten. This fills holes.
//
// Usage:
//   node --env-file=.env scripts/enrich-places.mjs             # dry run
//   node --env-file=.env scripts/enrich-places.mjs --commit    # write
//   node scripts/enrich-places.mjs --sql > fill.sql            # SQL to paste
//   node scripts/enrich-places.mjs --refresh                   # re-download
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const SOCRATA = 'https://data.cityofnewyork.us/resource/43nn-pn8j.json';
const CACHE_DIR = '.cache';
const CACHE = `${CACHE_DIR}/nyc-food-establishments.json`;
const PAGE = 50000;
/** Two records this far apart are the same restaurant seen twice. */
const SAME_PLACE_M = 150;

const flags = process.argv.slice(2);
const commit = flags.includes('--commit');
const sqlOnly = flags.includes('--sql');
const refresh = flags.includes('--refresh');

/** stdout is the deliverable in --sql mode, so the log goes to stderr. */
const log = sqlOnly ? (...a) => console.error(...a) : (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * Every establishment with a point, one row each.
 *
 * The dataset is one row per INSPECTION — a restaurant open ten years appears
 * dozens of times — so it is folded by CAMIS, the permit number, which is the
 * only stable identity in it. The newest row wins: a place that moved or was
 * re-tenanted has its latest address last.
 */
async function download() {
	const rows = [];
	for (let offset = 0; ; offset += PAGE) {
		const url =
			`${SOCRATA}?$select=camis,dba,boro,building,street,zipcode,cuisine_description,latitude,longitude,inspection_date` +
			`&$where=latitude is not null and latitude != 0&$order=camis&$limit=${PAGE}&$offset=${offset}`;
		log(`  fetching rows ${offset}…`);
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`NYC Open Data answered ${res.status}`);
		const page = await res.json();
		rows.push(...page);
		if (page.length < PAGE) break;
	}

	const byCamis = new Map();
	for (const r of rows) {
		const lat = Number(r.latitude);
		const lng = Number(r.longitude);
		// (0, 0) is the dataset's way of saying it could not geocode one.
		if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
		const prev = byCamis.get(r.camis);
		if (prev && (prev.on ?? '') >= (r.inspection_date ?? '')) continue;
		byCamis.set(r.camis, {
			camis: r.camis,
			name: r.dba ?? '',
			boro: r.boro ?? '',
			address: [r.building, r.street].filter(Boolean).join(' '),
			zip: r.zipcode ?? '',
			cuisine: r.cuisine_description ?? '',
			lat,
			lng,
			on: r.inspection_date ?? '',
		});
	}
	return [...byCamis.values()];
}

async function source() {
	if (!refresh && existsSync(CACHE)) {
		const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
		log(`source: ${cached.length} establishments (cached — --refresh to re-download)`);
		return cached;
	}
	const rows = await download();
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE, JSON.stringify(rows));
	log(`source: ${rows.length} establishments, cached to ${CACHE}`);
	return rows;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Words that carry no identity, on either side of the comparison. */
const NOISE = new Set([
	'RESTAURANT', 'RESTAURANTE', 'CAFE', 'CAFETERIA', 'BAR', 'GRILL', 'KITCHEN',
	'NYC', 'NY', 'NEW', 'YORK', 'BROOKLYN', 'QUEENS', 'MANHATTAN', 'BRONX',
	'THE', 'INC', 'LLC', 'CORP', 'CO', 'AND', 'OF',
]);

function normalise(raw) {
	const folded = raw
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		// A branch after a pipe or a bilingual tail is not part of the name.
		.split('|')[0]
		.replace(/[^A-Z0-9 ]+/g, ' ');
	const words = folded.split(/\s+/).filter(Boolean);
	const kept = words.filter((w) => !NOISE.has(w));
	// A name made entirely of noise ("The Restaurant") keeps its words rather
	// than normalising to nothing and matching everything.
	return (kept.length ? kept : words).join(' ');
}

function metres(a, b) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/** Title Case, because the source shouts: "PIZZA HUT" → "Pizza hut". */
function tidyCuisine(raw) {
	const v = raw.trim().toLowerCase();
	if (!v || v === 'not listed/not applicable' || v === 'other') return null;
	return v[0].toUpperCase() + v.slice(1);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const db = (() => {
	const url = process.env.SUPABASE_URL;
	if (!url) {
		if (commit) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to --commit');
		return null;
	}
	const key = commit
		? process.env.SUPABASE_SERVICE_ROLE_KEY
		: (process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY);
	if (!key) {
		if (commit) throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set to --commit');
		return null;
	}
	return createClient(url, key, { auth: { persistSession: false } });
})();

if (!db) {
	console.error('SUPABASE_URL and a key are needed even for a dry run — it reads the places to fill.');
	process.exit(1);
}

const rows = await source();

/** Normalised name → the establishments answering to it. */
const index = new Map();
for (const r of rows) {
	const key = normalise(r.name);
	if (!key) continue;
	const list = index.get(key) ?? [];
	list.push(r);
	index.set(key, list);
}

const { data: places, error } = await db
	.from('restaurant_places')
	.select('id,name,lat,lng,neighborhood,cuisines,city')
	.is('lat', null)
	.order('id');
if (error) throw new Error(error.message);

log(`\n${places.length} places with no point.\n`);

const filled = [];
const ambiguous = [];
const missing = [];

for (const place of places) {
	const key = normalise(place.name);
	const candidates = index.get(key) ?? [];

	if (candidates.length === 0) {
		missing.push(place);
		continue;
	}
	// Several records for one restaurant is normal — a permit renewed, a second
	// counter in the same building. Several records in different postcodes is
	// two restaurants with one name, and nothing here can tell them apart.
	const spread = candidates.every((c) => metres(candidates[0], c) <= SAME_PLACE_M);
	if (!spread) {
		ambiguous.push({ place, candidates });
		continue;
	}
	filled.push({ place, hit: candidates[0] });
}

for (const { place, hit } of filled) {
	const cuisine = tidyCuisine(hit.cuisine);
	log(
		`  fill     ${place.name.slice(0, 32).padEnd(32)} ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}  ` +
			`${hit.boro.padEnd(13)} ${cuisine ?? ''}`,
	);
}
for (const { place, candidates } of ambiguous) {
	log(
		`  ambiguous ${place.name.slice(0, 31).padEnd(31)} ${candidates.length} places answer to that name: ` +
			candidates.map((c) => `${c.address}, ${c.boro}`).slice(0, 3).join(' · '),
	);
}
log(`\n${filled.length} to fill · ${ambiguous.length} ambiguous · ${missing.length} not in the source`);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function patch(place, hit) {
	const cuisine = tidyCuisine(hit.cuisine);
	const set = { lat: hit.lat, lng: hit.lng };
	// The source knows the borough, which is what the location line wants when
	// there is no neighbourhood — "Queens, New York" rather than a bare city.
	if (!place.neighborhood && hit.boro && hit.boro !== 'Manhattan') set.neighborhood = hit.boro;
	if (place.cuisines.length === 0 && cuisine) set.cuisines = [cuisine];
	return set;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

if (sqlOnly) {
	for (const { place, hit } of filled) {
		const set = patch(place, hit);
		const assignments = [
			`lat = ${set.lat}`,
			`lng = ${set.lng}`,
			...(set.neighborhood ? [`neighborhood = ${quote(set.neighborhood)}`] : []),
			...(set.cuisines ? [`cuisines = array[${set.cuisines.map(quote).join(', ')}]::text[]`] : []),
			'updated_at = now()',
		];
		console.log(`update public.restaurants set ${assignments.join(', ')} where id = ${place.id};`);
	}
} else if (commit) {
	let written = 0;
	for (const { place, hit } of filled) {
		const { error: e } = await db.from('restaurants').update(patch(place, hit)).eq('id', place.id);
		if (e) {
			log(`  FAILED   ${place.name}: ${e.message}`);
			continue;
		}
		written += 1;
	}
	log(`\n${written} places filled in.`);
} else {
	log('\nnothing written. re-run with --commit to fill them, or --sql for the statements.');
}
