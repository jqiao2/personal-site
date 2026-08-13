// Bulk-add places to the to-try list, from a list of names.
//
// Written for the case that keeps coming up: a list of restaurants that lives
// somewhere else — a Google Maps saved list, a note, a text someone sent you —
// and wants to be on the to-try list without being typed in one at a time.
//
// It takes NAMES, not coordinates, because a name is what those lists actually
// contain and because looking one up is the same job the composer already
// does: Nominatim, one request a second, and only a point-precise hit is
// allowed to become a location. A neighbourhood centroid is not where a
// restaurant is, so a place that only matches an area is still added — it just
// goes on the list unplaced, and says so.
//
// Usage:
//   node --env-file=.env scripts/import-to-try.mjs list.txt                     # dry run
//   node --env-file=.env scripts/import-to-try.mjs list.txt --commit            # write
//   node --env-file=.env scripts/import-to-try.mjs <maps-list-url> --near "New York"
//   node scripts/import-to-try.mjs <maps-list-url> --near "New York" --sql > add.sql
//
// INPUT is either a FILE or a GOOGLE MAPS SAVED LIST.
//
// A file is one place per line: a plain name, or "Name, where" to pin the
// lookup ("Wu's Wonton King, Two Bridges"). A Google Takeout CSV works as-is —
// its Title column is read and the rest ignored. Blank lines and #comments are
// skipped.
//
// A saved list is any link to one — the maps.app.goo.gl share link, the long
// /maps/placelists/list/… URL, or the bare list id. THREE FIELDS ARE READ OFF
// IT AND NO MORE: the name you saved, the note you left on it, and the day you
// saved it. Google's own coordinates, address and place id are deliberately
// left behind — the point of this script is that the location comes from the
// same open geocode the composer uses, so an imported place and a hand-added
// one are the same kind of record rather than two kinds that happen to sit in
// one table. The note becomes `to_try_reason`, which is the "why I want to go"
// the to-try list is mostly made of, and the day saved becomes
// `to_try_added_at`, so the list arrives in the order you built it.
//
// MATCHING, which is the part that can be wrong. A geocoder asked for a
// restaurant by name will always answer something; the risk is not a miss but a
// confident hit on a different place — "929", "Taste Good" and "Copacabana" are
// names half the world shares, and searching them plainly returns a place in
// Niagara Falls, a place in Jackson Heights and a beach. So a hit has to clear
// three bars before its coordinates are used:
//
//   1. it is point-precise, not the centroid of an area;
//   2. its own OSM name looks like the name asked for;
//   3. it is where the saved entry says that restaurant is.
//
// The third bar is a REJECTION TEST and nothing more. The saved point is never
// stored and never averaged in — a hit more than a walk away from it is simply
// a different restaurant with the same name, and this is the only signal that
// can tell those apart. Every coordinate that lands in the database still comes
// from the open geocode, exactly as it does when a place is added by hand.
//
// A hit that clears none of the three is not an error — the place is still
// added, unplaced, and the run says so, which is a five-second fix in the
// composer against a wrong pin nobody will notice.
//
// OUTPUT is a dry run by default. --commit writes with the service-role key;
// --sql prints the equivalent INSERT for a project you can only reach through
// the SQL editor. Only --commit needs credentials.
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
/**
 * How far a hit may sit from where the source says the place is: 1.2 km, about
 * fifteen minutes' walk. Wide enough for OSM and Google to disagree about which
 * door a restaurant uses, or for a saved pin dropped on the block rather than
 * the building; far too narrow for the same-named place in the next
 * neighbourhood to slip through.
 */
const MATCH_RADIUS_M = 1200;

const [, , source, ...flags] = process.argv;
const commit = flags.includes('--commit');
const sqlOnly = flags.includes('--sql');
/**
 * `--near "New York"` — the town the whole list is in. Looked up once and used
 * as the bounds every other lookup is confined to, which is a far stronger hint
 * than putting the same words in the query: "Taste Good, New York" still finds
 * the one in Niagara Falls, because that is in New York too.
 */
const near = flagValue('--near') ?? '';
if (!source) {
	console.error('usage: node --env-file=.env scripts/import-to-try.mjs <file|maps-list-url> [--near "New York"] [--commit|--sql]');
	process.exit(1);
}

function flagValue(name) {
	const i = flags.indexOf(name);
	return i >= 0 ? flags[i + 1] : undefined;
}

/** stdout is the deliverable in --sql mode, so the log goes to stderr. */
const log = sqlOnly ? (...a) => console.error(...a) : (...a) => console.log(...a);

let db = null;
if (commit) {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to --commit');
		process.exit(1);
	}
	db = createClient(url, key, { auth: { persistSession: false } });
} else if (process.env.SUPABASE_URL) {
	// A dry run reads if it can — that is how it can tell you what it would
	// skip — but it must not require credentials to preview an import, and the
	// read it needs is one the anon key can already do: the restaurants table is
	// public to select. Either key works; neither is required.
	const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (key) db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Names, one per line. A Takeout CSV contributes its Title column. */
function parseFile(text) {
	const lines = text.split(/\r?\n/).map((l) => l.trim());
	const header = lines[0]?.toLowerCase() ?? '';
	const isCsv = header.startsWith('title,') || header.includes(',note,') || header.includes(',url');
	const rows = isCsv ? lines.slice(1) : lines;
	return rows
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => (isCsv ? splitCsv(l)[0] ?? '' : l))
		.map((n) => n.trim().replace(/^"|"$/g, ''))
		.filter(Boolean)
		.map((line) => {
			// "Name, where" pins the lookup: the whole line is searched, the part
			// before the comma is the name that gets stored.
			const [name] = line.split(',');
			return { name: name.trim(), query: line, reason: null, addedAt: null, at: null };
		});
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

function isMapsList(s) {
	return /^https?:\/\//i.test(s) || /^[A-Za-z0-9_-]{16,32}$/.test(s);
}

/**
 * The list id out of whatever form of link was pasted.
 *
 * A share link is a redirect to the long URL, which carries the id in its
 * protobuf-ish `data` segment as `!2s<id>`; the /placelists/ URL has it in the
 * path. Following the short link is the only way to learn it.
 */
async function listId(input) {
	if (!/^https?:\/\//i.test(input)) return input;
	const res = await fetch(input, { headers: { 'user-agent': USER_AGENT } });
	const url = res.url ?? input;
	return (
		url.match(/placelists\/list\/([A-Za-z0-9_-]+)/)?.[1] ??
		url.match(/!2s([A-Za-z0-9_-]{16,})/)?.[1] ??
		null
	);
}

/**
 * The saved list itself, from the endpoint the list page preloads.
 *
 * `pb` is Google's URL-packed protobuf and the shape is theirs, not ours: the
 * id, the two enums that ask for the entries rather than just the header, and a
 * page size big enough to take a list in one request. It is read the way the
 * page reads it, which is the only interface a shared list has.
 */
async function fetchList(id) {
	const pb = `!1m1!1s${id}!2e2!3e2!4i500!28e2!16b1`;
	const url = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&pb=${encodeURIComponent(pb)}`;
	const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
	if (!res.ok) throw new Error(`the list could not be read (HTTP ${res.status})`);
	const text = await res.text();
	// Google prefixes its JSON with )]}' to make it unusable as a script tag.
	const body = JSON.parse(text.slice(text.indexOf('[')));
	const header = body?.[0] ?? [];
	const entries = (header[8] ?? []).map((row) => {
		const name = (row?.[2] ?? '').trim();
		const reason = (row?.[3] ?? '').trim() || null;
		const savedAt = row?.[9]?.[0] ?? null;
		// [ , , lat, lng] — read to CHECK a match, never to become one. See the
		// third bar in the matching note at the top.
		const point = row?.[1]?.[5] ?? null;
		return {
			name,
			query: searchable(name),
			reason,
			addedAt: savedAt ? new Date(savedAt * 1000).toISOString() : null,
			at: point?.[2] != null && point?.[3] != null ? { lat: point[2], lng: point[3] } : null,
		};
	});
	return { title: header[4] ?? '(untitled)', entries: entries.filter((e) => e.name) };
}

/**
 * The name as it goes to the geocoder.
 *
 * Saved-list names carry things OSM does not: a branch after a pipe ("Mikiya
 * Wagyu Shabu House | Manhattan"), a bilingual tail ("Chong Qing Wharf Hot Pot
 * &…山城码头火锅"). Both make a lookup miss that the plain name finds, so they
 * come off the query — and off the query only. What gets STORED is the name as
 * saved, because that is the name that will be recognised in the list.
 */
function searchable(name) {
	let q = name.split('|')[0];
	// Latin and CJK in one name: search the Latin half, which is what OSM indexes.
	if (/[㐀-鿿぀-ヿ가-힯]/.test(q) && /[A-Za-z]{3}/.test(q)) {
		q = q.replace(/[㐀-鿿぀-ヿ가-힯]+/g, ' ');
	}
	return q.replace(/[&＆]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The same name with the district off the end, for a second try.
 *
 * A saved list distinguishes branches the way a person does — "Taverna Kyclades
 * Astoria", "Nowon East Village", "Laser Wolf Brooklyn" — and OSM knows all
 * three by their bare names, so the qualifier that makes the entry readable is
 * exactly what makes the lookup miss. Only a TRAILING district comes off, and
 * only when the first pass found nothing: "Brooklyn Crab" keeps its Brooklyn.
 */
const DISTRICTS = new Set([
	'nyc', 'ny', 'new', 'york', 'city', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten',
	'island', 'astoria', 'flushing', 'elmhurst', 'harlem', 'chinatown', 'east', 'west', 'lower',
	'upper', 'side', 'village', 'heights', 'park', 'slope',
]);
function trimDistrict(query) {
	const words = query.split(' ');
	while (words.length > 1 && DISTRICTS.has(normalise(words[words.length - 1]))) words.pop();
	const trimmed = words.join(' ');
	return trimmed === query ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Lookup and matching
// ---------------------------------------------------------------------------

let lastCallAt = 0;
async function geocode(query, viewbox = null) {
	const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastCallAt = Date.now();

	const u = new URL(NOMINATIM);
	u.searchParams.set('q', query);
	u.searchParams.set('format', 'jsonv2');
	u.searchParams.set('addressdetails', '1');
	// The cuisine lives in extratags, and it is a field that would otherwise be
	// typed in by hand for every one of these.
	u.searchParams.set('extratags', '1');
	u.searchParams.set('limit', '10');
	if (viewbox) {
		// Bounded to the town the list is about, which is both a better search
		// and a cheaper one: "Taste Good" unbounded is a restaurant in Niagara
		// Falls, and no amount of ", New York" on the end of the query moves it.
		u.searchParams.set('viewbox', viewbox);
		u.searchParams.set('bounded', '1');
	}
	try {
		const res = await fetch(u, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
		if (!res.ok) return [];
		return await res.json();
	} catch {
		return [];
	}
}

/** The `--near` town as a viewbox Nominatim can be bounded to. */
async function boundsOf(place) {
	const [hit] = await geocode(place);
	const b = hit?.boundingbox;
	// left,top,right,bottom from Nominatim's south,north,west,east.
	return b ? `${b[2]},${b[1]},${b[3]},${b[0]}` : null;
}

/** Metres between two points, close enough at city scale. */
function metresBetween(a, b) {
	const R = 6371000;
	const rad = (d) => (d * Math.PI) / 180;
	const dLat = rad(b.lat - a.lat);
	const dLng = rad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/** Lower-cased, unaccented, unpunctuated — the form two names can be compared in. */
function normalise(s) {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** Words that carry no identity: two places sharing only these share nothing. */
const GENERIC = new Set([
	'the', 'a', 'and', 'of', 'de', 'la', 'el', 'restaurant', 'restaurante', 'cafe', 'caffe',
	'coffee', 'bar', 'grill', 'kitchen', 'house', 'shop', 'store', 'market', 'bakery', 'deli',
	'pizzeria', 'pizza', 'nyc', 'new', 'york', 'brooklyn', 'queens', 'manhattan', 'bronx', 'inc',
	'co', 'company', 'food', 'foods', 'cuisine', 'restaurants',
]);

/**
 * Does this hit look like the place that was asked for?
 *
 * Nominatim answers every query with something, so the failure mode worth
 * guarding is a confident hit on an unrelated place of the same-ish name. The
 * test is deliberately simple and deliberately strict: one name contains the
 * other, or they share every distinguishing word of the shorter one. Anything
 * fuzzier starts accepting "Copacabana" the beach for "Copacabana" the
 * Brazilian place in Astoria.
 */
function matches(wanted, hit) {
	const a = normalise(searchable(wanted));
	const b = normalise(hit.name ?? (hit.display_name ?? '').split(',')[0] ?? '');
	if (!a || !b) return false;
	if (a === b || a.includes(b) || b.includes(a)) return true;

	const words = (s) => s.split(' ').filter((w) => w && !GENERIC.has(w));
	const wa = words(a);
	const wb = words(b);
	if (wa.length === 0 || wb.length === 0) return false;
	const shorter = wa.length <= wb.length ? wa : wb;
	const longer = new Set(wa.length <= wb.length ? wb : wa);
	return shorter.every((w) => longer.has(w));
}

/** The first hit that is a point, the right name, and in the right place. */
function pick(rows, entry) {
	const candidates = rows.filter(
		(r) => (r.place_rank ?? 0) >= PRECISE_PLACE_RANK && r.category !== 'boundary' && matches(entry.name, r),
	);
	if (candidates.length === 0) return null;
	if (!entry.at) {
		// Nothing to check against. One candidate is an answer; several are a
		// coin toss, and an unplaced row beats a coin toss.
		return candidates.length === 1 ? candidates[0] : null;
	}
	const near_ = candidates
		.map((r) => ({ r, m: metresBetween(entry.at, { lat: Number(r.lat), lng: Number(r.lon) }) }))
		.filter(({ m }) => m <= MATCH_RADIUS_M)
		.sort((a, b) => a.m - b.m);
	return near_[0]?.r ?? null;
}

/** Which bar the lookup failed at, so a run can be read rather than trusted. */
function why(rows, entry) {
	const named = rows.filter((r) => matches(entry.name, r));
	if (named.length === 0) return rows.length === 0 ? 'nothing found' : 'nothing by that name';
	const points = named.filter((r) => (r.place_rank ?? 0) >= PRECISE_PLACE_RANK && r.category !== 'boundary');
	if (points.length === 0) return 'the name matches an area, not a place';
	if (!entry.at) return 'several places share the name';
	const km = Math.min(
		...points.map((r) => metresBetween(entry.at, { lat: Number(r.lat), lng: Number(r.lon) })),
	) / 1000;
	return `the nearest "${points[0].name}" is ${km.toFixed(1)} km off`;
}

function titleCase(v) {
	const s = v.trim().replace(/_/g, ' ');
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * OSM's neighbourhood, or nothing, depending on which kind of answer it gave.
 *
 * Two of its answers are not neighbourhoods a person would say. A community
 * board is a unit of city government — "Manhattan Community Board 3" is where
 * Katz's lands — and reads as an error on a restaurant card, so it becomes the
 * null this column is designed to hold. A historic district IS the
 * neighbourhood, wearing a landmarks-commission suffix: "Cobble Hill Historic
 * District" is Cobble Hill, and losing two words makes it right.
 */
function neighbourhood(a) {
	const raw = a.neighbourhood ?? a.suburb ?? a.quarter ?? null;
	if (!raw || /community board/i.test(raw)) return null;
	return raw.replace(/\s+(historic\s+)?district$/i, '').trim() || null;
}

function toRow(entry, hit) {
	const a = hit?.address ?? {};
	return {
		name: entry.name,
		cuisines: (hit?.extratags?.cuisine ?? '').split(';').map(titleCase).filter(Boolean),
		neighborhood: neighbourhood(a),
		city: a.city ?? a.town ?? a.village ?? a.municipality ?? near ?? 'New York',
		state_region: a.state ?? null,
		country: a.country_code ? a.country_code.toUpperCase() : 'US',
		lat: hit ? Number(hit.lat) : null,
		lng: hit ? Number(hit.lon) : null,
		to_try_reason: entry.reason,
		to_try_added_at: entry.addedAt ?? new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// One lookup up front so every lookup after it is bounded to the right town.
const viewbox = near ? await boundsOf(near) : null;
if (near && !viewbox) log(`! could not place "${near}" — searching the whole world instead`);

let entries;
if (isMapsList(source)) {
	const id = await listId(source);
	if (!id) {
		console.error(`could not find a list id in ${source}`);
		process.exit(1);
	}
	const list = await fetchList(id);
	entries = list.entries;
	log(`"${list.title}" — ${entries.length} place${entries.length === 1 ? '' : 's'}`);
} else {
	entries = parseFile(readFileSync(source, 'utf8'));
	log(`${entries.length} name${entries.length === 1 ? '' : 's'} in ${source}`);
}
if (entries.length === 0) {
	console.error('nothing to import');
	process.exit(1);
}

// Reading what's already there is how re-runs stay safe. A dry run survives
// without it — previewing an import should not need write credentials — but a
// --commit that can't check for duplicates would create them, so that stops.
let existingRows = [];
if (db) {
	const { data, error } = await db.from('restaurants').select('name');
	if (error && commit) {
		console.error('could not read existing places, refusing to write:', error.message);
		process.exit(1);
	}
	if (error) log(`! could not read existing places (${error.message}) — nothing checked for duplicates`);
	existingRows = data ?? [];
} else {
	log('! no credentials — nothing checked against what is already on the list');
}
// Compared unaccented: "Bánh Mì Cô Út" and a hand-typed "Banh mi co ut" are one
// place, and importing the second on top of the first is the duplicate this is
// here to prevent.
const existing = new Set(existingRows.map((r) => normalise(r.name)));

log(commit ? '' : sqlOnly ? '' : '  (dry run — pass --commit to write)\n');

const toInsert = [];
let placed = 0;
let unplaced = 0;
let skipped = 0;

for (const entry of entries) {
	if (existing.has(normalise(entry.name))) {
		log(`  skip     ${entry.name}  (already on record)`);
		skipped++;
		continue;
	}
	const ask = (q) => geocode(near && !viewbox ? `${q}, ${near}` : q, viewbox);
	let rows = await ask(entry.query);
	let hit = pick(rows, entry);
	const retry = hit ? null : trimDistrict(entry.query);
	if (retry) {
		const more = await ask(retry);
		hit = pick(more, entry);
		if (hit || rows.length === 0) rows = more;
	}
	const row = toRow(entry, hit);
	if (hit) {
		placed++;
		log(
			`  found    ${entry.name.padEnd(34)} ${(row.neighborhood ?? row.city ?? '').padEnd(22)} ${row.lat.toFixed(4)}, ${row.lng.toFixed(4)}  [${hit.type}]`,
		);
	} else {
		unplaced++;
		log(`  unplaced ${entry.name.padEnd(34)} ${why(rows, entry)} — added without a point`);
	}
	toInsert.push(row);
	existing.add(normalise(entry.name));
}

log(`\n${placed} placed · ${unplaced} unplaced · ${skipped} already on record`);

if (toInsert.length === 0) {
	log('\nnothing to add.');
	process.exit(0);
}

if (sqlOnly) {
	console.log(sql(toInsert));
	process.exit(0);
}
if (!commit) {
	log('\nnothing written. re-run with --commit to add them.');
	process.exit(0);
}

const { error } = await db.from('restaurants').insert(toInsert);
if (error) {
	console.error('\ninsert failed:', error.message);
	process.exit(1);
}
log(`\nadded ${toInsert.length} place${toInsert.length === 1 ? '' : 's'} to the to-try list.`);

/** The same rows as one statement, for a project reachable only by SQL editor. */
function sql(rows) {
	const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
	const arr = (v) => (v.length === 0 ? `'{}'` : `array[${v.map(lit).join(', ')}]::text[]`);
	const values = rows
		.map(
			(r) =>
				`\t(${lit(r.name)}, ${arr(r.cuisines)}, ${lit(r.neighborhood)}, ${lit(r.city)}, ${lit(r.state_region)}, ${lit(r.country)}, ${r.lat ?? 'null'}, ${r.lng ?? 'null'}, ${lit(r.to_try_reason)}, ${lit(r.to_try_added_at)})`,
		)
		.join(',\n');
	return `insert into public.restaurants
	(name, cuisines, neighborhood, city, state_region, country, lat, lng, to_try_reason, to_try_added_at)
values
${values};`;
}
