// Bulk-add places to the to-try list, from a list of names.
//
// Written for the case that keeps coming up: a list of restaurants that lives
// somewhere else — a Google Maps saved list exported through Takeout, a note,
// a text someone sent you — and wants to be on the to-try list without being
// typed in one at a time.
//
// It takes NAMES, not coordinates, because a name is what those lists actually
// contain and because looking one up is the same job the composer already
// does: Nominatim, one request a second, and only a point-precise hit is
// allowed to become a location. A neighbourhood centroid is not where a
// restaurant is, so a place that only matches an area is still added — it just
// goes on the list unplaced, and says so.
//
// Usage:
//   node --env-file=.env scripts/import-to-try.mjs list.txt          # dry run
//   node --env-file=.env scripts/import-to-try.mjs list.txt --commit # write
//
// INPUT: one place per line. Either a plain name, or "Name, where" to pin the
// lookup ("Wu's Wonton King, Two Bridges"). A Google Takeout CSV works as-is —
// its Title column is read and the rest ignored. Blank lines and #comments are
// skipped.
//
// It is safe to re-run: a name already in the database is reported and skipped
// rather than duplicated.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const USER_AGENT = 'jasonqiao.com restaurant log (https://jasonqiao.com)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100;
/** Below this, a Nominatim result is an area and its point is a centroid. */
const PRECISE_PLACE_RANK = 30;

const [, , file, ...flags] = process.argv;
const commit = flags.includes('--commit');
if (!file) {
	console.error('usage: node --env-file=.env scripts/import-to-try.mjs <file> [--commit]');
	process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
	process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** Names, one per line. A Takeout CSV contributes its Title column. */
function parse(text) {
	const lines = text.split(/\r?\n/).map((l) => l.trim());
	const header = lines[0]?.toLowerCase() ?? '';
	const isCsv = header.startsWith('title,') || header.includes(',note,') || header.includes(',url');
	const rows = isCsv ? lines.slice(1) : lines;
	return rows
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => (isCsv ? splitCsv(l)[0] ?? '' : l))
		.map((n) => n.trim().replace(/^"|"$/g, ''))
		.filter(Boolean);
}

/** Enough CSV for Takeout: quoted fields, doubled quotes inside them. */
function splitCsv(line) {
	const out = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cur += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}

let lastCallAt = 0;
async function geocode(query) {
	const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastCallAt = Date.now();

	const u = new URL(NOMINATIM);
	u.searchParams.set('q', query);
	u.searchParams.set('format', 'jsonv2');
	u.searchParams.set('addressdetails', '1');
	u.searchParams.set('limit', '5');
	try {
		const res = await fetch(u, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
		if (!res.ok) return null;
		const rows = await res.json();
		// The first point-precise hit. An area is no use as a location, and
		// taking one anyway is how a restaurant ends up pinned to the middle of
		// its neighbourhood.
		return (
			rows.find((r) => (r.place_rank ?? 0) >= PRECISE_PLACE_RANK && r.category !== 'boundary') ?? null
		);
	} catch {
		return null;
	}
}

function toRow(name, hit) {
	const a = hit?.address ?? {};
	return {
		name,
		cuisines: [],
		neighborhood: a.neighbourhood ?? a.suburb ?? a.quarter ?? null,
		city: a.city ?? a.town ?? a.village ?? a.municipality ?? 'New York',
		state_region: a.state ?? null,
		country: a.country_code ? a.country_code.toUpperCase() : 'US',
		lat: hit ? Number(hit.lat) : null,
		lng: hit ? Number(hit.lon) : null,
		to_try_added_at: new Date().toISOString(),
	};
}

const names = parse(readFileSync(file, 'utf8'));
if (names.length === 0) {
	console.error(`no names found in ${file}`);
	process.exit(1);
}

// Reading what's already there is how re-runs stay safe. A dry run survives
// without it — previewing an import should not need write credentials — but a
// --commit that can't check for duplicates would create them, so that stops.
const { data: existingRows, error: readError } = await db.from('restaurants').select('name');
if (readError && commit) {
	console.error('could not read existing places, refusing to write:', readError.message);
	process.exit(1);
}
if (readError) {
	console.warn(`! could not read existing places (${readError.message})`);
	console.warn('! dry run continues, but nothing is checked for duplicates\n');
}
const existing = new Set((existingRows ?? []).map((r) => r.name.toLowerCase()));

console.log(`${names.length} name${names.length === 1 ? '' : 's'} in ${file}${commit ? '' : '  (dry run — pass --commit to write)'}\n`);

const toInsert = [];
let placed = 0;
let unplaced = 0;
let skipped = 0;

for (const raw of names) {
	const name = raw.split(',')[0].trim();
	if (existing.has(name.toLowerCase())) {
		console.log(`  skip     ${name}  (already on record)`);
		skipped++;
		continue;
	}
	const hit = await geocode(raw);
	const row = toRow(name, hit);
	if (hit) {
		placed++;
		console.log(
			`  found    ${name.padEnd(30)} ${(row.neighborhood ?? row.city ?? '').padEnd(20)} ${row.lat.toFixed(4)}, ${row.lng.toFixed(4)}  [${hit.type}]`,
		);
	} else {
		unplaced++;
		console.log(`  unplaced ${name.padEnd(30)} no exact match — added without a point`);
	}
	toInsert.push(row);
	existing.add(name.toLowerCase());
}

console.log(`\n${placed} placed · ${unplaced} unplaced · ${skipped} already on record`);

if (!commit) {
	console.log('\nnothing written. re-run with --commit to add them.');
	process.exit(0);
}
if (toInsert.length === 0) {
	console.log('\nnothing to add.');
	process.exit(0);
}

const { error } = await db.from('restaurants').insert(toInsert);
if (error) {
	console.error('\ninsert failed:', error.message);
	process.exit(1);
}
console.log(`\nadded ${toInsert.length} place${toInsert.length === 1 ? '' : 's'} to the to-try list.`);
