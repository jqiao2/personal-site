// Turn a Beli account, as fetched by beli-fetch.mjs, into rows of this log.
//
// Beli models the same three things this section does — a place, a visit, a
// list of somewhere to go — so the import is mostly a rename. The interesting
// part is the three places where the two models genuinely disagree, and each
// one is resolved here in the direction of recording LESS rather than inventing
// something that was never said:
//
// THE SCORE IS A RATING AND NOT A VERDICT. Beli's number is 0-10 and comes out
// of pairwise comparisons — you never typed it, you produced it by repeatedly
// saying "this one over that one". Halved and rounded to the log's nearest half
// star it is a fair `rating`. It is NOT a `verdict`: the verdict scale in
// 0030_restaurant_log.sql asks how much of the meal you would order again, which
// is a different axis that a quality score cannot answer — a 9.5 you would never
// repeat because it cost a fortune is rung 1, and no arithmetic on the 9.5 can
// know that. So `verdict` is imported as NULL, on purpose, and filled in by hand
// in the composer over time. An imported place is a place with a rating and no
// verdict yet, which the app already renders correctly.
//
// THE DATE IS WHEN YOU LOGGED IT, NOT WHEN YOU ATE. `restaurant_visits.visited_on`
// is NOT NULL and Beli's list carries the day the entry was created. For an app
// people open at the table those are usually the same day and occasionally not,
// so the logged-at date is used and every row that had no date at all is listed
// at the end of the run rather than quietly given today's.
//
// ONE VISIT PER PLACE. Beli's ranked list is one row per restaurant, not one per
// meal — it has no notion of the second time you went. So an import produces
// exactly one visit per place, and `revisit` stays false because nothing in the
// data says otherwise. Meals after this arrive through the composer as normal.
//
// The bookmarked list becomes the to-try list: `to_try_added_at` from the day you
// saved it, `to_try_reason` from the note if there is one. That is the same
// destination scripts/import-to-try.mjs writes to, and the two agree about
// duplicates — both compare unaccented names — so running one after the other is
// safe in either order.
//
// Usage:
//   node scripts/import-beli.mjs beli-jqiao.json                    # dry run
//   node --env-file=.env scripts/import-beli.mjs beli-jqiao.json --commit
//   node scripts/import-beli.mjs beli-jqiao.json --sql > beli.sql
//
// A dry run needs no credentials and writes nothing; it prints every row it
// would create. Only --commit writes, and it is safe to re-run — a place whose
// name is already on record is reported and skipped rather than duplicated.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const [, , source, ...flags] = process.argv;
const commit = flags.includes('--commit');
const sqlOnly = flags.includes('--sql');

if (!source) {
	console.error('usage: node scripts/import-beli.mjs <file.json> [--commit|--sql]');
	process.exit(1);
}

/** stdout is the deliverable in --sql mode, so the log goes to stderr. */
const log = sqlOnly ? (...a) => console.error(...a) : (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Reading the fetched file
// ---------------------------------------------------------------------------

/**
 * Beli's field names, with their history.
 *
 * The list endpoint returns a flattened join, so a restaurant's own columns
 * arrive prefixed — `business__name` rather than a nested business object. That
 * prefix is what the 2022 scraper read and what the endpoint still used when
 * this was written, but it is exactly the kind of thing that changes without
 * warning, so every field is looked up through a list of candidates and the
 * first one present wins. A field that matches none of its candidates is
 * reported at the end of the run rather than silently becoming null.
 */
const FIELDS = {
	name: ['business__name', 'business_name', 'name'],
	status: ['status', 'business__status'],
	score: ['score', 'rating', 'business__score'],
	neighborhood: ['business__neighborhood', 'neighborhood'],
	city: ['business__city', 'city'],
	region: ['business__state', 'business__region', 'state', 'region'],
	country: ['business__country', 'country'],
	cuisines: ['business__cuisines', 'cuisines'],
	price: ['business__price', 'price'],
	lat: ['business__latitude', 'business__lat', 'latitude', 'lat'],
	lng: ['business__longitude', 'business__lng', 'longitude', 'lng'],
	notes: ['notes', 'note', 'review', 'comment'],
	createdAt: ['created_at', 'created', 'date_created', 'timestamp'],
	googlePlaceId: ['business__google_place_id', 'google_place_id', 'place_id'],
};

/**
 * Which fields were ever resolved, so the run can report the ones that never
 * were. Per-row absence means nothing — plenty of places have no neighbourhood
 * and no note — but a field that matched none of its candidates on ANY row is
 * a name that has moved, and that is worth saying out loud.
 */
const seen = new Set();

function field(row, key) {
	for (const candidate of FIELDS[key]) {
		if (row[candidate] !== undefined && row[candidate] !== null) {
			seen.add(key);
			return row[candidate];
		}
	}
	return null;
}

function rowsOf(payload) {
	if (Array.isArray(payload)) return payload;
	for (const key of ['results', 'data', 'items']) {
		if (Array.isArray(payload?.[key])) return payload[key];
	}
	return [];
}

const file = JSON.parse(readFileSync(source, 'utf8'));
const rows = rowsOf(file.rank_list ?? file);
if (rows.length === 0) {
	console.error(`no rows in ${source}. re-run beli-fetch.mjs?`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// The two lists
// ---------------------------------------------------------------------------

/**
 * Which side of the log a row belongs on.
 *
 * Beli keeps been-there and want-to-go in one list distinguished by a status,
 * and the exact spelling of that status is theirs. Anything that reads like a
 * bookmark goes to the to-try list; anything with a score is somewhere you have
 * eaten, because a score only exists after a comparison; everything else is
 * treated as a visit, which is the commoner case and the recoverable one — a
 * place wrongly given a visit is visible in the diary, where a place wrongly put
 * on the to-try list quietly disappears into eighty others.
 */
function isBookmark(row) {
	const status = String(field(row, 'status') ?? '').toLowerCase();
	if (/bookmark|want|to.?try|wishlist|saved/.test(status)) return true;
	if (/been|visited|ranked|rated/.test(status)) return false;
	return field(row, 'score') == null;
}

/**
 * Beli's 0-10, as this log's half stars.
 *
 * Halved, rounded to the nearest half, and floored at 0.5 because the schema's
 * check constraint starts there: a 0.2 on Beli is not "no rating", it is the
 * worst meal of the year, and half a star is how this log says that.
 */
function toRating(score) {
	if (score == null) return null;
	const n = Number(score);
	if (!Number.isFinite(n)) return null;
	return Math.min(5, Math.max(0.5, Math.round((n / 2) * 2) / 2));
}

/** Beli's 1-4 price, as the log's four bands. */
function toPriceBand(price) {
	const n = Number(price);
	if (!Number.isFinite(n) || n < 1) return null;
	return '$'.repeat(Math.min(4, Math.round(n)));
}

function toCuisines(v) {
	const list = Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/[;,]/) : [];
	return list
		.map((c) => String(c).trim().replace(/_/g, ' '))
		.filter(Boolean)
		.map((c) => c[0].toUpperCase() + c.slice(1));
}

/** A `date` column wants a day, not an instant. */
function toDay(v) {
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toTimestamp(v) {
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A number in range, or null.
 *
 * The empty check is load-bearing rather than defensive: `Number(null)` is 0,
 * and 0 is a perfectly valid latitude, so without it every place Beli has no
 * coordinates for would be placed in the Gulf of Guinea instead of left
 * unplaced.
 */
function num(v, lo, hi) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/** Lower-cased, unaccented, unpunctuated — the form two names can be compared in. */
function normalise(s) {
	return String(s)
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * The country as a two-letter code, which is what the rest of the table holds.
 *
 * Beli is inconsistent about this — a code on some rows, a full name on others
 * — and the column's default is 'US', so an unconverted "United States" would
 * sit beside 'US' as a second country meaning the same thing and split every
 * grouping that uses it.
 */
function toCountry(v) {
	const raw = String(v ?? '').trim();
	if (!raw) return 'US';
	if (/^(usa?|united states( of america)?)$/i.test(raw)) return 'US';
	return raw.length === 2 ? raw.toUpperCase() : raw;
}

/**
 * The place, as a `restaurants` row.
 *
 * `city` is NOT NULL in the schema and Beli does not always have one, so a place
 * with no city falls back to the country and finally to a dash. That is a
 * visible placeholder rather than a plausible wrong city, which is the point —
 * it sorts to the top of the places list and asks to be fixed.
 */
function toPlace(row) {
	return {
		name: String(field(row, 'name') ?? '').trim(),
		cuisines: toCuisines(field(row, 'cuisines')),
		price_band: toPriceBand(field(row, 'price')),
		neighborhood: field(row, 'neighborhood') || null,
		city: field(row, 'city') || field(row, 'country') || '—',
		state_region: field(row, 'region') || null,
		country: toCountry(field(row, 'country')),
		lat: num(field(row, 'lat'), -90, 90),
		lng: num(field(row, 'lng'), -180, 180),
		google_place_id: field(row, 'googlePlaceId') || null,
	};
}

// ---------------------------------------------------------------------------
// What is already here
// ---------------------------------------------------------------------------

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
	// A dry run reads if it can — that is how it can tell you what it would skip
	// — but previewing an import must not require credentials, and the read it
	// needs is one the anon key already has: restaurants is public to select.
	const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (key) db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false } });
}

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
const existing = new Set(existingRows.map((r) => normalise(r.name)));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

log(`${rows.length} row${rows.length === 1 ? '' : 's'} in ${source}`);
log(commit || sqlOnly ? '' : '  (dry run — pass --commit to write)\n');

/** Places with the visit that goes with them, kept together until the insert. */
const visited = [];
const toTry = [];
const undated = [];
let skipped = 0;

for (const row of rows) {
	const place = toPlace(row);
	if (!place.name) continue;

	if (existing.has(normalise(place.name))) {
		log(`  skip     ${place.name}  (already on record)`);
		skipped++;
		continue;
	}
	existing.add(normalise(place.name));

	const savedAt = toTimestamp(field(row, 'createdAt'));
	const note = field(row, 'notes') || null;

	if (isBookmark(row)) {
		toTry.push({
			...place,
			to_try_added_at: savedAt ?? new Date().toISOString(),
			to_try_reason: note,
		});
		log(`  to-try   ${place.name.padEnd(38)} ${place.neighborhood ?? place.city}`);
		continue;
	}

	const rating = toRating(field(row, 'score'));
	const day = toDay(field(row, 'createdAt'));
	if (!day) undated.push(place.name);

	visited.push({
		place,
		visit: {
			// visited_on is filled in against today only when Beli had no date at
			// all. Those names are listed at the end of the run so they can be
			// corrected rather than believed.
			visited_on: day ?? new Date().toISOString().slice(0, 10),
			rating,
			// Deliberately null. See the note at the top: the score is a rating,
			// and the verdict is a question it cannot answer.
			verdict: null,
			review: note,
		},
	});
	log(
		`  visit    ${place.name.padEnd(38)} ${(place.neighborhood ?? place.city ?? '').padEnd(20)} ${
			rating != null ? `${rating.toFixed(1)}★` : '  —  '
		}  ${day ?? 'no date'}`,
	);
}

log(
	`\n${visited.length} visited · ${toTry.length} to try · ${skipped} already on record`,
);
if (undated.length > 0) {
	log(`\n! ${undated.length} had no date and were dated today — fix these in the composer:`);
	for (const n of undated) log(`    ${n}`);
}
const never = Object.keys(FIELDS).filter((k) => !seen.has(k));
if (never.length > 0) {
	// Beli moving a field name is the likeliest way this script goes quietly
	// wrong, so it is said out loud rather than left as a column of nulls.
	log(`\n! nothing matched on any row for: ${never.sort().join(', ')}`);
	log('  (their field names may have moved — check the fetched JSON against FIELDS)');
}

if (visited.length === 0 && toTry.length === 0) {
	log('\nnothing to add.');
	process.exit(0);
}

if (sqlOnly) {
	console.log(sql(visited, toTry));
	process.exit(0);
}
if (!commit) {
	log('\nnothing written. re-run with --commit to add them.');
	process.exit(0);
}

// The to-try rows are plain inserts; the visited ones need their place's id
// before the visit can reference it, so those go in a place at a time and the
// visit follows. Slower, and the only way to get the foreign key without
// inventing ids here.
if (toTry.length > 0) {
	const { error } = await db.from('restaurants').insert(toTry);
	if (error) {
		console.error('\nto-try insert failed:', error.message);
		process.exit(1);
	}
}

let written = 0;
for (const { place, visit } of visited) {
	const { data, error } = await db.from('restaurants').insert(place).select('id').single();
	if (error) {
		console.error(`\ninsert failed for ${place.name}: ${error.message}`);
		process.exit(1);
	}
	const { error: visitError } = await db
		.from('restaurant_visits')
		.insert({ ...visit, restaurant_id: data.id });
	if (visitError) {
		// The place landed and its visit did not, which is the one state this
		// loop can leave behind that a re-run would NOT fix: the name is now on
		// record, so a second run skips it as a duplicate and the visit is never
		// written. Taking the place back out again makes the failure clean and
		// the re-run correct.
		await db.from('restaurants').delete().eq('id', data.id);
		console.error(`\nvisit insert failed for ${place.name}: ${visitError.message}`);
		console.error('the place was rolled back, so re-running will retry it.');
		process.exit(1);
	}
	written++;
}

log(`\nadded ${written} visited place${written === 1 ? '' : 's'} and ${toTry.length} to the to-try list.`);

/** The same rows as SQL, for a project reachable only by the SQL editor. */
function sql(visitedRows, toTryRows) {
	const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
	const arr = (v) => (v.length === 0 ? `'{}'` : `array[${v.map(lit).join(', ')}]::text[]`);
	const out = [];

	if (toTryRows.length > 0) {
		const values = toTryRows
			.map(
				(r) =>
					`\t(${lit(r.name)}, ${arr(r.cuisines)}, ${lit(r.price_band)}, ${lit(r.neighborhood)}, ${lit(r.city)}, ${lit(r.state_region)}, ${lit(r.country)}, ${r.lat ?? 'null'}, ${r.lng ?? 'null'}, ${lit(r.google_place_id)}, ${lit(r.to_try_added_at)}, ${lit(r.to_try_reason)})`,
			)
			.join(',\n');
		out.push(`insert into public.restaurants
	(name, cuisines, price_band, neighborhood, city, state_region, country, lat, lng, google_place_id, to_try_added_at, to_try_reason)
values
${values};`);
	}

	// A CTE per place so the visit can name the id the insert just produced —
	// the SQL equivalent of the insert-then-insert loop above.
	for (const { place: p, visit: v } of visitedRows) {
		out.push(`with place as (
	insert into public.restaurants
		(name, cuisines, price_band, neighborhood, city, state_region, country, lat, lng, google_place_id)
	values
		(${lit(p.name)}, ${arr(p.cuisines)}, ${lit(p.price_band)}, ${lit(p.neighborhood)}, ${lit(p.city)}, ${lit(p.state_region)}, ${lit(p.country)}, ${p.lat ?? 'null'}, ${p.lng ?? 'null'}, ${lit(p.google_place_id)})
	returning id
)
insert into public.restaurant_visits (restaurant_id, visited_on, rating, verdict, review)
select id, ${lit(v.visited_on)}, ${v.rating ?? 'null'}, null, ${lit(v.review)} from place;`);
	}

	return out.join('\n\n');
}
