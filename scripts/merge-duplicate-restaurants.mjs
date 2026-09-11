// Find restaurant rows that are the same real place, and fold them into one.
//
// WHY THEY EXIST. `restaurants` is one table for two things — the places you
// have eaten at and the places you mean to — and a place can arrive twice: on
// the to-try list from one gazetteer source's search, then again as a fresh row
// when a visit is logged from a different source (picking a suggestion COPIES
// its fields in, it does not join). The visit lands on one row, the to-try flag
// stays on the other, and the place never leaves the to-try list even though it
// has been visited. Merging the pair onto one row fixes that for free — the
// view's `on_to_try` goes false the moment the visit and the flag share a row.
//
// The merge is NON-DESTRUCTIVE: a duplicate is pointed at its canonical row via
// `restaurants.merged_into` (migration 0066), which hides it and repoints its
// visits. Nothing is deleted, so a wrong merge is reversible.
//
// Usage:
//   node --env-file=.env scripts/merge-duplicate-restaurants.mjs            # dry run
//   node --env-file=.env scripts/merge-duplicate-restaurants.mjs --commit   # apply
//   node scripts/merge-duplicate-restaurants.mjs --self-check               # unit test
//
// CONSERVATIVE ON PURPOSE. Merging two genuinely different places erases a real
// place from every page, which is far worse than leaving a duplicate. So two
// rows are only the same place when their names match AND they are within ~150m
// of each other — which is what keeps a chain's two branches (same name, far
// apart) apart. Only when a row has no coordinates at all does it fall back to
// name + city, because an unplaced to-try import is exactly the row that needs
// merging and the only thing left to match it on.
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

// How close two rows must be to be one place. About two short blocks: wide
// enough for two sources to disagree about which door a restaurant uses, far too
// narrow for the same-named place in the next neighbourhood to slip through.
const MERGE_RADIUS_M = 150;

// ---------------------------------------------------------------------------
// Pure clustering — no I/O, so the self-check can drive it directly.
// ---------------------------------------------------------------------------

/**
 * The same normalisation the gazetteer stores names under (see gazetteer.ts).
 * Copied rather than imported: this file runs as plain .mjs with no TS hook, and
 * the .ts module pulls in the Supabase client at load. Keep the two in step.
 */
export function normalise(raw) {
	return String(raw ?? '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim();
}

const EARTH_M = 6371000;
function metres(aLat, aLng, bLat, bLng) {
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(bLat - aLat);
	const dLng = toRad(bLng - aLng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

const hasCoords = (r) => r.lat != null && r.lng != null;
const cityKey = (r) => String(r.city ?? '').trim().toLowerCase();

/** Are these two rows the same real place? Conservative — see the file header. */
export function samePlace(a, b) {
	const na = normalise(a.name);
	const nb = normalise(b.name);
	if (!na || !nb) return false;
	const nameMatch = na === nb || na.includes(nb) || nb.includes(na);
	if (!nameMatch) return false;

	if (hasCoords(a) && hasCoords(b)) {
		// Both placed: the name matches, so it comes down to distance. This is the
		// guard that keeps a franchise's branches apart.
		return metres(a.lat, a.lng, b.lat, b.lng) < MERGE_RADIUS_M;
	}
	// One or both unplaced — no distance to check. Require an EXACT name (not just
	// a substring) and the same city, or a chain with no coords would collapse.
	return na === nb && !!cityKey(a) && cityKey(a) === cityKey(b);
}

/** The canonical row of a cluster: most visits wins, tie-broken by age then id. */
function keepOf(cluster) {
	return cluster.reduce((best, r) => {
		if ((r.visit_count ?? 0) !== (best.visit_count ?? 0)) {
			return (r.visit_count ?? 0) > (best.visit_count ?? 0) ? r : best;
		}
		if (r.created_at !== best.created_at) return r.created_at < best.created_at ? r : best;
		return r.id < best.id ? r : best;
	});
}

/**
 * Group rows into clusters of the same place. O(n²) union-find over a few
 * hundred rows — the whole log fits in memory. Returns only clusters bigger than
 * one, each with its kept row and the ids to fold in.
 */
export function cluster(rows) {
	// ponytail: O(n²) pairwise, fine at a few hundred rows; index by name if it grows.
	const parent = new Map(rows.map((r) => [r.id, r.id]));
	const find = (id) => {
		while (parent.get(id) !== id) {
			parent.set(id, parent.get(parent.get(id)));
			id = parent.get(id);
		}
		return id;
	};
	const uni = (a, b) => parent.set(find(a), find(b));

	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			if (samePlace(rows[i], rows[j])) uni(rows[i].id, rows[j].id);
		}
	}

	const groups = new Map();
	for (const r of rows) {
		const root = find(r.id);
		(groups.get(root) ?? groups.set(root, []).get(root)).push(r);
	}
	return [...groups.values()]
		.filter((g) => g.length > 1)
		.map((g) => {
			const keep = keepOf(g);
			return { keep, drops: g.filter((r) => r.id !== keep.id), rows: g };
		});
}

// ---------------------------------------------------------------------------
// Self-check — node scripts/merge-duplicate-restaurants.mjs --self-check
// ---------------------------------------------------------------------------

async function selfCheck() {
	const assert = (await import('node:assert/strict')).default;
	const same = (a, b) => samePlace(a, b);

	// Same name, close (~40m apart at this latitude) → merge.
	assert.equal(same(
		{ name: 'Di Fara Pizza', lat: 40.6249, lng: -73.9615, city: 'New York' },
		{ name: 'Di Fara Pizza', lat: 40.6252, lng: -73.9615, city: 'New York' },
	), true, 'same name, close together should merge');

	// One name contains the other, close → merge (a source that adds a suffix).
	assert.equal(same(
		{ name: 'Tacos El Bronco', lat: 40.6580, lng: -74.0090, city: 'New York' },
		{ name: 'Tacos El Bronco Truck', lat: 40.6581, lng: -74.0090, city: 'New York' },
	), true, 'a contained name, close together should merge');

	// Same name, far apart (a chain) → do NOT merge.
	assert.equal(same(
		{ name: 'Shake Shack', lat: 40.7414, lng: -73.9880, city: 'New York' },
		{ name: 'Shake Shack', lat: 40.7580, lng: -73.9855, city: 'New York' },
	), false, 'same name, far apart (chain) must not merge');

	// Different name, same spot → do NOT merge.
	assert.equal(same(
		{ name: 'Joe’s Pizza', lat: 40.7306, lng: -74.0027, city: 'New York' },
		{ name: 'Prince Street Pizza', lat: 40.7306, lng: -74.0027, city: 'New York' },
	), false, 'different names must not merge');

	// Missing coords, same name + city → merge (the unplaced-to-try case).
	assert.equal(same(
		{ name: 'Tatiana', lat: null, lng: null, city: 'New York' },
		{ name: 'Tatiana', lat: 40.7726, lng: -73.9830, city: 'New York' },
	), true, 'missing coords, same name and city should merge');

	// Missing coords, same name but different city → do NOT merge.
	assert.equal(same(
		{ name: 'Superiority Burger', lat: null, lng: null, city: 'New York' },
		{ name: 'Superiority Burger', lat: null, lng: null, city: 'Los Angeles' },
	), false, 'same name, different city must not merge');

	// keepOf: the visited row wins over a to-try-only duplicate.
	const [c] = cluster([
		{ id: 5, name: 'Cheeky', lat: null, lng: null, city: 'New York', visit_count: 0, created_at: '2024-01-01' },
		{ id: 9, name: 'Cheeky', lat: null, lng: null, city: 'New York', visit_count: 3, created_at: '2024-06-01' },
	]);
	assert.equal(c.keep.id, 9, 'the visited row should be kept');
	assert.deepEqual(c.drops.map((d) => d.id), [5], 'the to-try-only row should be dropped');

	console.log('ok — clustering self-check passed');
}

// ---------------------------------------------------------------------------
// Run against the live database (guarded so importing this file is side-effect free)
// ---------------------------------------------------------------------------

async function run() {
	const commit = process.argv.includes('--commit');

	const url = process.env.SUPABASE_URL;
	const key = commit
		? process.env.SUPABASE_SERVICE_ROLE_KEY
		: (process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY);
	if (!url || !key) {
		console.error('SUPABASE_URL and a key must be set (service-role key to --commit).');
		process.exit(1);
	}
	const db = createClient(url, key, { auth: { persistSession: false } });

	// restaurant_places already excludes merged rows and hands us visit_count, so
	// a re-run after a commit finds nothing.
	const { data, error } = await db
		.from('restaurant_places')
		.select('id,name,lat,lng,city,neighborhood,visit_count,created_at');
	if (error) {
		console.error('could not read places:', error.message);
		process.exit(1);
	}
	const clusters = cluster(data ?? []);

	if (clusters.length === 0) {
		console.log('no duplicate places found — nothing to merge.');
		process.exit(0);
	}

	console.log(commit ? '' : '(dry run — pass --commit to apply)\n');
	const place = (r) =>
		`${r.name}  [${[r.neighborhood, r.city].filter(Boolean).join(', ') || '—'}]` +
		`${r.lat != null ? ` ${r.lat.toFixed(4)},${r.lng.toFixed(4)}` : ' (unplaced)'}` +
		`  ${r.visit_count} visit${r.visit_count === 1 ? '' : 's'}`;
	for (const { keep, drops } of clusters) {
		console.log(`keep  #${keep.id}  ${place(keep)}`);
		for (const d of drops) console.log(`  merge #${d.id}  ${place(d)}`);
		console.log('');
	}
	console.log(
		`${clusters.length} cluster${clusters.length === 1 ? '' : 's'}, ` +
		`${clusters.reduce((n, c) => n + c.drops.length, 0)} row(s) to fold in.`,
	);

	if (!commit) {
		console.log('\nnothing written. re-run with --commit to apply.');
		process.exit(0);
	}

	for (const { keep, drops } of clusters) {
		await mergeCluster(db, keep.id, drops.map((d) => d.id));
	}
	console.log('\nmerged.');
}

/**
 * The merge, replicated from mergePlaces() in src/lib/restaurants.ts — kept
 * identical so the two agree. Same ordering: repoint visits, fill keep, hide
 * drops. See that function's comment for why the order is load-bearing.
 */
async function mergeCluster(db, keepId, dropIds) {
	const { data: rows, error } = await db.from('restaurants').select('*').in('id', [keepId, ...dropIds]);
	if (error) throw new Error(error.message);
	const byId = new Map((rows ?? []).map((r) => [r.id, r]));
	const keep = byId.get(keepId);
	const dropRows = dropIds.map((id) => byId.get(id)).filter(Boolean);

	const repoint = await db.from('restaurant_visits').update({ restaurant_id: keepId }).in('restaurant_id', dropIds);
	if (repoint.error) throw new Error(repoint.error.message);

	const payload = { updated_at: new Date().toISOString() };
	for (const col of [
		'lat', 'lng', 'neighborhood', 'borough', 'city', 'state_region', 'country',
		'price_band', 'website_url', 'yelp_url', 'beli_url', 'google_place_id',
		'to_try_added_at', 'to_try_reason',
	]) {
		if (keep[col] == null) {
			const from = dropRows.find((d) => d[col] != null);
			if (from) payload[col] = from[col];
		}
	}
	const union = (col) => {
		const seen = new Set();
		for (const row of [keep, ...dropRows]) for (const v of row[col] ?? []) seen.add(v);
		return [...seen];
	};
	const cuisines = union('cuisines');
	if (cuisines.length > (keep.cuisines ?? []).length) payload.cuisines = cuisines;
	const toTryTags = union('to_try_tags');
	if (toTryTags.length > (keep.to_try_tags ?? []).length) payload.to_try_tags = toTryTags;
	if (!keep.trip && dropRows.some((d) => d.trip)) payload.trip = true;
	if (Object.keys(payload).length > 1) {
		const fill = await db.from('restaurants').update(payload).eq('id', keepId);
		if (fill.error) throw new Error(fill.error.message);
	}

	const mark = await db
		.from('restaurants')
		.update({ merged_into: keepId, to_try_added_at: null, updated_at: new Date().toISOString() })
		.in('id', dropIds);
	if (mark.error) throw new Error(mark.error.message);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.includes('--self-check')) await selfCheck();
	else await run();
}
