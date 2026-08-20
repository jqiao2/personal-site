// Fill in the location tiers that 0033 added, for the places already logged.
//
// 0033 added seven columns — the street, the quarter, the borough, and OSM's
// own identity — and every existing row has them null. They are not typed in:
// every one of them is already implied by the point the place was pinned at, so
// the backfill is a reverse geocode per placed restaurant and nothing else.
//
// ONLY PLACED ROWS. A place with no lat/lng has nothing to reverse-geocode
// FROM, and guessing from its city would invent a street. Those stay null and
// are reported at the end; placing them by hand is what the dialog is for.
//
// IT FILLS HOLES AND NEVER OVERWRITES, the same rule enrich-places.mjs runs by.
// Anything already in a column was confirmed by hand at log time and is better
// evidence than a geocode: only columns that are null get written. That also
// makes the run safely repeatable — a second pass has nothing left to do.
//
// EXCEPT city/state/country, WHICH ARE NEVER TOUCHED AT ALL. They are on the
// far side of that rule for a different reason: `city` is NOT NULL and
// createPlace defaults it to "New York" when a place is added with just a name,
// so it is never null, so hole-filling could not correct it anyway — and a
// geocode is not good enough evidence to overwrite a city with. The one thing
// this run does change about how a place READS is the borough, which is a new
// column and was null by definition.
//
// THE PACING IS NOT OPTIONAL. It reuses `reverseGeocode` from src/lib/geocode.ts
// rather than reimplementing it, which means it also inherits that module's
// shared one-request-a-second pacer and its User-Agent. Nominatim is
// volunteer-run and that pacing is the rent. 333 placed rows is about six
// minutes; let it run.
//
// Responses are cached under .cache/ by coordinate, so a re-run after an
// interruption costs nothing and only the rows not yet seen hit the network.
//
// Usage:
//   node --env-file=.env scripts/backfill-place-location.mjs            # dry run
//   node --env-file=.env scripts/backfill-place-location.mjs --commit   # write
//   node --env-file=.env scripts/backfill-place-location.mjs --limit 20 # a taste
//   node --env-file=.env scripts/backfill-place-location.mjs --refresh  # ignore cache
//
// On Node 22.12–22.x add --experimental-strip-types; Node 23.6+ strips the
// types in the import below on its own.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { reverseGeocode } from '../src/lib/geocode.ts';

const CACHE_DIR = '.cache';
const CACHE = `${CACHE_DIR}/reverse-geocode.json`;

const flags = process.argv.slice(2);
const commit = flags.includes('--commit');
const refresh = flags.includes('--refresh');
const limitAt = flags.indexOf('--limit');
const limit = limitAt >= 0 ? Number(flags[limitAt + 1]) : Infinity;

// The columns this writes: the WORDS, and only the words.
//
// osm_type/osm_id/place_rank are deliberately NOT here, and the reason is the
// single most important thing about this script. Reverse geocoding returns
// whatever object happens to sit nearest the point — asked about a Sunset Park
// restaurant's pin, Nominatim answers `node/2561552351`, which is a nail salon
// two doors down. That is a perfectly good answer to "what is at these
// coordinates" and a completely wrong answer to "which OSM object is this
// restaurant". Writing it into osm_id would manufacture exactly the false
// provenance the column was added to provide honestly.
//
// The address tiers do not have that problem: the nail salon and the restaurant
// share a street, a neighbourhood and a borough, which is why those are safe to
// read off a neighbour and an identity is not.
//
// So existing rows get no OSM identity from this run, and that is correct —
// it is only recorded going forward, when a named hit is picked deliberately in
// the composer and the match is a name match rather than a proximity one.
const FIELDS = ['house_number', 'road', 'neighborhood', 'quarter', 'borough'];

const url = process.env.PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('Need PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
	console.error('Run with: node --env-file=.env scripts/backfill-place-location.mjs');
	process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/** Keyed by the point, because that is the whole of the question asked. */
const cacheKey = (lat, lng) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

function loadCache() {
	if (refresh || !existsSync(CACHE)) return {};
	try {
		return JSON.parse(readFileSync(CACHE, 'utf8'));
	} catch {
		return {};
	}
}

function saveCache(cache) {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { data: rows, error } = await db
	.from('restaurants')
	.select('id,name,lat,lng,house_number,road,neighborhood,quarter,borough')
	.not('lat', 'is', null)
	.not('lng', 'is', null)
	.order('id');
if (error) {
	console.error(`Could not read the places: ${error.message}`);
	process.exit(1);
}

// Rows already carrying every field have nothing to gain from a lookup, so they
// never cost a request. On a second run that is all of them.
const todo = rows.filter((r) => FIELDS.some((f) => r[f] == null)).slice(0, limit);

console.log(`${rows.length} placed restaurants, ${todo.length} with at least one field to fill.`);
if (!commit) console.log('DRY RUN — nothing will be written. Add --commit to write.\n');

const cache = loadCache();
let filled = 0;
let unanswered = 0;
let unchanged = 0;
const changes = [];

for (const [i, row] of todo.entries()) {
	const key = cacheKey(row.lat, row.lng);
	let hit = cache[key];

	if (hit === undefined) {
		hit = await reverseGeocode(row.lat, row.lng);
		// Cached either way: a point OSM has no answer for still has no answer
		// on the next run, and null is the answer worth remembering.
		cache[key] = hit;
		// Written as we go, so an interrupted run keeps everything it paid for.
		if (i % 10 === 0) saveCache(cache);
	}

	if (!hit) {
		unanswered += 1;
		console.log(`  ?  ${row.name} — OSM had nothing at ${key}`);
		continue;
	}

	// Hole-filling, field by field: a column that already has something keeps it.
	const patch = {};
	const offered = {
		house_number: hit.houseNumber,
		road: hit.road,
		neighborhood: hit.neighborhood,
		quarter: hit.quarter,
		borough: hit.borough,
	};
	for (const [col, value] of Object.entries(offered)) {
		if (row[col] == null && value != null) patch[col] = value;
	}

	if (Object.keys(patch).length === 0) {
		unchanged += 1;
		continue;
	}

	filled += 1;
	changes.push({ name: row.name, patch });
	const summary = Object.entries(patch)
		.map(([c, v]) => `${c}=${v}`)
		.join('  ');
	console.log(`  +  ${row.name}\n       ${summary}`);

	if (commit) {
		const { error: writeError } = await db.from('restaurants').update(patch).eq('id', row.id);
		if (writeError) console.error(`  !  ${row.name} — ${writeError.message}`);
	}
}

saveCache(cache);

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

const boroughs = {};
for (const c of changes) {
	if (c.patch.borough) boroughs[c.patch.borough] = (boroughs[c.patch.borough] ?? 0) + 1;
}

console.log(`\n${filled} places ${commit ? 'filled in' : 'would be filled in'}.`);
if (unchanged) console.log(`${unchanged} already had everything OSM could offer.`);
if (unanswered) console.log(`${unanswered} sit at points OSM has no address for.`);
if (Object.keys(boroughs).length) {
	const line = Object.entries(boroughs)
		.sort((a, b) => b[1] - a[1])
		.map(([b, n]) => `${b} ${n}`)
		.join(', ');
	console.log(`Boroughs found: ${line}`);
}

const { count: unplaced } = await db
	.from('restaurants')
	.select('id', { count: 'exact', head: true })
	.is('lat', null);
if (unplaced) {
	console.log(`\n${unplaced} places have no point at all, so nothing here could reach them.`);
	console.log('Those need placing by hand — the place dialog does it in ten seconds.');
}

if (!commit && filled) console.log('\nRe-run with --commit to write this. The cache means it will not re-fetch.');
