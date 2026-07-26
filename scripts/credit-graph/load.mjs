// Stage 2 of the credit-graph pipeline: NDJSON cache -> Supabase.
//
// Reads scripts/.cache/credit-graph/films.ndjson (written by fetch.mjs) and
// upserts it into the credit_films / credit_people / credits tables from
// migration 0015. Pure data movement — no TMDB traffic — so it is cheap to
// re-run, and idempotent: every write is an upsert keyed on the primary key,
// so a re-run converges rather than duplicating.
//
// Requires migration 0015 to have been applied (`supabase db push`, or paste
// supabase/migrations/0015_credit_graph.sql into the SQL editor).
//
// Usage (env supplies SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY):
//   node --env-file=.env scripts/credit-graph/load.mjs [options]
//     --dry-run    Parse and report totals, write nothing
//     --limit=<n>  Only load the first n films (smoke test)

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = flag('dry-run');
const LIMIT = opt('limit') ? Number.parseInt(opt('limit'), 10) : Infinity;

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY_RUN && (!SB_URL || !SB_KEY)) {
	console.error('Missing env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
	console.error('Run with: node --env-file=.env scripts/credit-graph/load.mjs');
	process.exit(1);
}

const FILMS_FILE = path.join('scripts', '.cache', 'credit-graph', 'films.ndjson');

/** Rows per PostgREST request. Small columns, so a large batch is fine and keeps
 * the round-trip count (and total wall time) down. */
const BATCH = 2000;
/** Batches in flight at once. Supabase handles this comfortably. */
const PARALLEL = 4;

const supabase = DRY_RUN
	? null
	: createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Read the NDJSON cache into the three table shapes, de-duplicated by primary
 * key. A film can legitimately appear twice in the file (an interrupted run
 * re-fetched it), so later records win — they are identical in practice. */
async function readCache() {
	const films = new Map();
	const people = new Map();
	const credits = new Map();

	const rl = createInterface({ input: createReadStream(FILMS_FILE), crlfDelay: Infinity });
	let bad = 0;
	for await (const line of rl) {
		if (!line.trim()) continue;
		let f;
		try {
			f = JSON.parse(line);
		} catch {
			bad++;
			continue;
		}
		if (films.size >= LIMIT && !films.has(f.id)) continue;

		films.set(f.id, {
			tmdb_id: f.id,
			title: f.title,
			release_year: f.year,
			vote_count: f.vote_count ?? 0,
			vote_average: f.vote_average ?? null,
			popularity: f.popularity ?? null,
			revenue: f.revenue ?? 0,
			countries: f.countries ?? [],
		});
		for (const c of f.credits ?? []) {
			people.set(c.id, { tmdb_id: c.id, name: c.name });
			credits.set(`${f.id}:${c.id}:${c.role}`, {
				film_id: f.id,
				person_id: c.id,
				role: c.role,
				billing: c.billing,
			});
		}
	}
	if (bad) console.log(`  (skipped ${bad} unparseable line(s) from an interrupted run)`);
	return { films: [...films.values()], people: [...people.values()], credits: [...credits.values()] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upsert one batch, retrying transient failures with backoff.
 *
 * A run this size (hundreds of batches over several minutes) will hit the odd
 * dropped connection — supabase-js surfaces those as a bare `TypeError: fetch
 * failed`, which killed an earlier full run at ~318k rows. Retrying is safe
 * because the write is an upsert: replaying a batch that already landed is a
 * no-op. Genuine schema/constraint errors come back as a PostgREST `error` with
 * a code, so those still fail fast rather than burning the budget. */
const TRANSIENT = /fetch failed|network|timeout|ECONN|EAI_AGAIN|socket/i;

async function upsertBatch(table, batch, conflict) {
	let lastError;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const { error } = await supabase
				.from(table)
				.upsert(batch, { onConflict: conflict, defaultToNull: false });
			if (!error) return;
			// PostgREST answered: the request is malformed, not unlucky.
			throw new Error(`${table}: ${error.message}`);
		} catch (e) {
			if (!TRANSIENT.test(e.message ?? '')) throw e;
			lastError = e;
		}
		await sleep(500 * 2 ** attempt);
	}
	throw new Error(`${table}: ${lastError?.message ?? 'unknown'} (after retries)`);
}

/** Upsert rows in batches, a few requests in flight at a time. `conflict` is the
 * comma-separated PK PostgREST resolves ON CONFLICT against. */
async function upsertAll(table, rows, conflict) {
	if (rows.length === 0) return;
	const batches = [];
	for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

	let done = 0;
	const queue = batches.slice();
	async function worker() {
		for (;;) {
			const batch = queue.shift();
			if (!batch) return;
			await upsertBatch(table, batch, conflict);
			done += batch.length;
			process.stdout.write(`\r  ${table}: ${done.toLocaleString()}/${rows.length.toLocaleString()}    `);
		}
	}
	await Promise.all(Array.from({ length: PARALLEL }, worker));
	process.stdout.write('\n');
}

async function main() {
	console.log(`Reading ${FILMS_FILE}…`);
	const { films, people, credits } = await readCache();

	const byRole = credits.reduce((acc, c) => ({ ...acc, [c.role]: (acc[c.role] ?? 0) + 1 }), {});
	console.log(
		`Parsed ${films.length.toLocaleString()} films, ${people.length.toLocaleString()} people, ` +
			`${credits.length.toLocaleString()} credits ` +
			`(${Object.entries(byRole).map(([r, n]) => `${n.toLocaleString()} ${r}`).join(', ')}).`,
	);
	if (DRY_RUN) {
		console.log('Dry run — nothing written.');
		return;
	}

	const started = Date.now();
	// Parents before children: credits carries FKs to both other tables.
	await upsertAll('credit_films', films, 'tmdb_id');
	await upsertAll('credit_people', people, 'tmdb_id');
	await upsertAll('credits', credits, 'film_id,person_id,role');

	console.log(`Loaded in ${((Date.now() - started) / 60000).toFixed(1)}m.`);
}

main().catch((e) => {
	console.error(`\n${e.message}`);
	if (/relation .* does not exist|Could not find the table/i.test(e.message)) {
		console.error('\nMigration 0015 has not been applied yet. Apply it with:');
		console.error('  supabase db push');
		console.error('or paste supabase/migrations/0015_credit_graph.sql into the Supabase SQL editor.');
	}
	process.exit(1);
});
