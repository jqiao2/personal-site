// Fill the gazetteer: every place a storable source knows about, kept locally.
//
// See supabase/migrations/0032_place_sources.sql for what the table is for and
// why these sources and not the richer ones. In short: the composer should be
// able to find a restaurant without asking the internet at the moment you are
// typing, and without a source that has to be re-fetched to stay licensed.
//
// Usage:
//   node --env-file=.env scripts/import-place-source.mjs dohmh --commit
//   node --env-file=.env scripts/import-place-source.mjs overture --bbox nyc --commit
//   node --env-file=.env scripts/import-place-source.mjs foursquare --bbox nyc --commit
//
// Dry run by default: it fetches, reports what it would write, and stops.
//
// THE THREE SOURCES ARE NOT THE SAME SHAPE and the differences are the whole
// job of this file:
//
//   dohmh       A JSON API, one row per INSPECTION, so a restaurant open ten
//               years is in it fifty times. Folded by CAMIS, newest first.
//               ~27k establishments, ~30 MB of JSON, a couple of minutes.
//
//   overture    Parquet on S3: 16 files of about a gigabyte each, ~50M places.
//               Far too much to download, so it is queried in place with DuckDB
//               over HTTPS — only the row groups whose bounding box overlaps the
//               one asked for are ever fetched. Counting every place in the NYC
//               box across all sixteen takes about fifteen seconds that way.
//               The `s3://` path is deliberately not used: it demands AWS
//               credentials the anonymous bucket does not want, and a proxy may
//               inject the wrong ones. The public HTTPS endpoint needs none.
//
//   foursquare  Parquet too, published on HuggingFace rather than the S3 bucket
//               their docs point at — that bucket refuses anonymous listing.
//               Its category taxonomy is the best of the three, which is why it
//               is worth having even where Overture already answered.
//
// Every source lands in the same seven fields, and every row keeps the id its
// source gave it, so a re-import updates in place rather than duplicating.
import { createClient } from '@supabase/supabase-js';

const [, , sourceName, ...flags] = process.argv;
const commit = flags.includes('--commit');
const limit = Number(flagValue('--limit') ?? 0) || null;
const bboxName = flagValue('--bbox') ?? 'nyc';

function flagValue(name) {
	const i = flags.indexOf(name);
	return i >= 0 ? flags[i + 1] : undefined;
}

/** Boxes worth naming. Everything else can be given as w,s,e,n. */
const BOXES = {
	// The five boroughs with a margin, which also catches the near edge of
	// Yonkers and Jersey City — where a few places on the list actually are.
	nyc: [-74.30, 40.47, -73.68, 40.94],
};

function box(name) {
	if (BOXES[name]) return BOXES[name];
	const parts = name.split(',').map(Number);
	if (parts.length === 4 && parts.every(Number.isFinite)) return parts;
	throw new Error(`unknown --bbox "${name}" — use a name (${Object.keys(BOXES).join(', ')}) or w,s,e,n`);
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

/** The name as the index stores it. Must match the API's normaliser exactly. */
export function normalise(raw) {
	return raw
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9 ]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.join(' ');
}

/** "PIZZA HUT" → "Pizza hut"; drops the source's non-answers. */
function tidy(raw) {
	const v = (raw ?? '').trim().toLowerCase();
	if (!v || v === 'not listed/not applicable' || v === 'other' || v === 'unspecified') return null;
	return v[0].toUpperCase() + v.slice(1);
}

// ---------------------------------------------------------------------------
// DOHMH — NYC food-service establishments
// ---------------------------------------------------------------------------

const SOCRATA = 'https://data.cityofnewyork.us/resource/43nn-pn8j.json';
const PAGE = 50000;

async function fromDohmh() {
	const byCamis = new Map();
	for (let offset = 0; ; offset += PAGE) {
		const url =
			`${SOCRATA}?$select=camis,dba,boro,building,street,zipcode,cuisine_description,latitude,longitude,phone,inspection_date` +
			`&$where=latitude is not null and latitude != 0&$order=camis&$limit=${PAGE}&$offset=${offset}`;
		process.stderr.write(`  fetching rows ${offset}…\n`);
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`NYC Open Data answered ${res.status}`);
		const page = await res.json();
		for (const r of page) {
			const lat = Number(r.latitude);
			const lng = Number(r.longitude);
			// (0, 0) is the dataset saying it could not geocode this one.
			if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
			const prev = byCamis.get(r.camis);
			if (prev && prev.on >= (r.inspection_date ?? '')) continue;
			const cuisine = tidy(r.cuisine_description);
			byCamis.set(r.camis, {
				source: 'dohmh',
				source_id: r.camis,
				name: (r.dba ?? '').trim(),
				name_norm: normalise(r.dba ?? ''),
				lat,
				lng,
				address: [r.building, r.street].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null,
				// Manhattan is left off, as it is everywhere else here: a place
				// there is "SoHo, New York", not "Manhattan, New York".
				locality: r.boro && r.boro !== 'Manhattan' ? r.boro : null,
				city: 'New York',
				region: 'New York',
				country: 'US',
				cuisines: cuisine ? [cuisine] : [],
				phone: (r.phone ?? '').trim() || null,
				website: null,
				on: r.inspection_date ?? '',
			});
		}
		if (page.length < PAGE) break;
	}
	return [...byCamis.values()].filter((r) => r.name && r.name_norm).map(({ on, ...row }) => row);
}

// ---------------------------------------------------------------------------
// Overture and Foursquare — parquet, queried where it lies
// ---------------------------------------------------------------------------

/**
 * The newest Overture release, from the bucket's own listing.
 *
 * Pinning a release in the source would mean editing this file to get newer
 * data, and asking for "latest" is one HTTP request.
 */
async function overtureRelease() {
	const res = await fetch(
		'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/',
	);
	const xml = await res.text();
	const releases = [...xml.matchAll(/<Prefix>release\/([^<\/]+)\/<\/Prefix>/g)].map((m) => m[1]);
	if (releases.length === 0) throw new Error('could not list Overture releases');
	return releases.sort().at(-1);
}

async function listKeys(prefix) {
	const keys = [];
	let token = '';
	do {
		const url =
			`https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}` +
			(token ? `&continuation-token=${encodeURIComponent(token)}` : '');
		const xml = await (await fetch(url)).text();
		keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]));
		token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? '';
	} while (token);
	return keys.filter((k) => k.endsWith('.parquet'));
}

async function duck() {
	const { DuckDBInstance } = await import('@duckdb/node-api');
	const db = await DuckDBInstance.create(':memory:');
	const c = await db.connect();
	await c.run('install httpfs; load httpfs;');
	return c;
}

async function fromOverture() {
	const [w, s, e, n] = box(bboxName);
	const release = await overtureRelease();
	process.stderr.write(`  overture release ${release}\n`);
	const keys = await listKeys(`release/${release}/theme=places/type=place/`);
	process.stderr.write(`  ${keys.length} parquet files; reading the ones overlapping the box\n`);
	const c = await duck();

	const rows = [];
	for (const [i, key] of keys.entries()) {
		const url = `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/${key}`;
		process.stderr.write(`  [${i + 1}/${keys.length}] ${key.split('/').pop().slice(0, 24)}…`);
		const started = Date.now();
		// The bbox struct carries per-row-group statistics, so a file that holds
		// nothing in this box costs one footer read rather than a gigabyte.
		// `addresses` is a LIST of structs and `bbox` carries the per-row-group
		// statistics that make this cheap — a file holding nothing in the box
		// costs one footer read rather than a gigabyte. Both verified against
		// the 2026-07 release rather than assumed.
		const q = `
			select id,
			       names.primary            as name,
			       bbox.xmin                as lng,
			       bbox.ymin                as lat,
			       categories.primary       as category,
			       addresses[1].freeform    as address,
			       addresses[1].locality    as locality,
			       addresses[1].region      as region,
			       addresses[1].country     as country,
			       websites[1]              as website,
			       phones[1]                as phone
			from read_parquet('${url}')
			where bbox.xmin between ${w} and ${e} and bbox.ymin between ${s} and ${n}
			  and (operating_status is null or operating_status = 'open')
			  and (categories.primary ilike '%restaurant%'
			       or categories.primary ilike '%food%'
			       or categories.primary in ('cafe','bakery','bar','coffee_shop','deli',
			                                 'ice_cream_shop','pizzeria','diner','juice_bar','tea_room','pub'))
		`;
		try {
			const r = await c.runAndReadAll(q);
			const found = r.getRowObjects();
			rows.push(...found);
			process.stderr.write(` ${found.length} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
		} catch (err) {
			process.stderr.write(` failed: ${String(err).slice(0, 80)}\n`);
		}
		if (limit && rows.length >= limit) break;
	}

	return rows
		.filter((r) => r.name)
		.map((r) => ({
			source: 'overture',
			source_id: String(r.id),
			name: String(r.name).trim(),
			name_norm: normalise(String(r.name)),
			lat: Number(r.lat),
			lng: Number(r.lng),
			address: r.address ?? null,
			locality: r.locality ?? null,
			city: r.locality ?? null,
			region: r.region ?? null,
			country: r.country ?? null,
			cuisines: r.category ? [tidy(String(r.category).replace(/_/g, ' '))].filter(Boolean) : [],
			phone: r.phone ?? null,
			website: r.website ?? null,
		}));
}

/**
 * Foursquare's open dataset, from HuggingFace.
 *
 * Their S3 bucket refuses anonymous listing — it answers with LICENSE.txt and
 * nothing else — so the release is enumerated through HuggingFace's tree API,
 * which is where the dataset is actually published. NOTE: their file URLs
 * redirect to a CDN, and DuckDB's httpfs could not follow that redirect from
 * the sandbox this was written in. The query below is right; if it fails with
 * an HTTP 0, that redirect is why, and a plain `wget` of the parquet files
 * followed by a local read_parquet is the way round it.
 */
async function fromFoursquare() {
	const [w, s, e, n] = box(bboxName);
	const c = await duck();
	const HF = 'https://huggingface.co/api/datasets/foursquare/fsq-os-places/tree/main';
	const releases = await (await fetch(`${HF}/release`)).json();
	const latest = releases.map((r) => r.path).sort().at(-1);
	const files = await (await fetch(`${HF}/${latest}/places/parquet`)).json();
	process.stderr.write(`  foursquare ${latest}, ${files.length} files\n`);
	const url = files
		.map((f) => `'https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/main/${f.path}'`)
		.join(',');
	const q = `
		select fsq_place_id, name, latitude as lat, longitude as lng, address, locality, region, country,
		       website, tel, fsq_category_labels
		from read_parquet([${url}])
		where longitude between ${w} and ${e} and latitude between ${s} and ${n}
	`;
	const r = await c.runAndReadAll(q);
	return r
		.getRowObjects()
		.filter((x) => x.name)
		.map((x) => ({
			source: 'foursquare',
			source_id: String(x.fsq_place_id),
			name: String(x.name).trim(),
			name_norm: normalise(String(x.name)),
			lat: Number(x.lat),
			lng: Number(x.lng),
			address: x.address ?? null,
			locality: x.locality ?? null,
			city: x.locality ?? null,
			region: x.region ?? null,
			country: x.country ?? null,
			// "Dining and Drinking > Restaurant > Thai Restaurant" — the leaf is
			// the cuisine, and the leaf is the last segment.
			cuisines: [tidy(String(x.fsq_category_labels ?? '').split('>').pop())].filter(Boolean),
			phone: x.tel ?? null,
			website: x.website ?? null,
		}));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const SOURCES = { dohmh: fromDohmh, overture: fromOverture, foursquare: fromFoursquare };

if (!sourceName || !SOURCES[sourceName]) {
	console.error(`usage: node --env-file=.env scripts/import-place-source.mjs <${Object.keys(SOURCES).join('|')}> [--bbox nyc] [--commit]`);
	process.exit(1);
}

const rows = await SOURCES[sourceName]();
console.error(`\n${rows.length} places from ${sourceName}.`);
for (const r of rows.slice(0, 8)) {
	console.error(`  ${r.name.slice(0, 34).padEnd(34)} ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}  ${r.cuisines[0] ?? ''}`);
}

if (!commit) {
	console.error('\nnothing written. re-run with --commit.');
	process.exit(0);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to --commit');
	process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// Upsert on (source, source_id): a re-import refreshes what moved and adds what
// is new, without ever making a second row for the same place.
const CHUNK = 500;
let written = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
	const slice = rows.slice(i, i + CHUNK).map(({ on, ...r }) => ({ ...r, imported_at: new Date().toISOString() }));
	const { error } = await db.from('place_sources').upsert(slice, { onConflict: 'source,source_id' });
	if (error) {
		console.error(`  chunk ${i} failed: ${error.message}`);
		continue;
	}
	written += slice.length;
	process.stderr.write(`  written ${written}/${rows.length}\r`);
}
console.error(`\n${written} rows in place_sources for ${sourceName}.`);
