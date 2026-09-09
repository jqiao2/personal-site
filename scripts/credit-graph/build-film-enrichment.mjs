// Full (re)build of the credit-graph enrichment the watched-films network reads:
//   - credit_films.reach_pct / gross_pct : each film's era-adjusted percentile of
//     vote_count / revenue vs a +/-2-year window (so a person's prominence is a
//     cheap aggregate over their films rather than a corpus-wide recompute).
//   - credit_people.region / region_list / era / reach / hit : each watched
//     person's career-wide region, era and prominence.
//   - src/data/credit-config.json : the stable bits the app needs but shouldn't
//     recompute -- role + colour-mode legends, and the two percentile priors.
//
// Uses the SAME logic as the corpus page (src/lib/credit-derive.mjs, copied from
// build.mjs). Run once to seed; the movie-add path (src/lib/credit-sync.ts) keeps
// it current incrementally afterwards, but a periodic full run heals any drift.
//
// Usage: node --env-file=.env scripts/credit-graph/build-film-enrichment.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
	countryProfile, careerEra, eraPercentiles, shrunkMean, regionLegend, eraLegend, COUNTRY_MIN_FILMS,
} from '../../src/lib/credit-derive.mjs';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ROLES = [
	{ role: 'actor', label: 'Actor', color: '#e0574f' },
	{ role: 'director', label: 'Director', color: '#4a8fd4' },
	{ role: 'composer', label: 'Composer', color: '#3fa87a' },
];
const ROLE_SHARE_FLOOR = 0.25;
const CONFIG_OUT = path.join('src', 'data', 'credit-config.json');

async function readAll(table, cols, order, filter) {
	const PAGE = 1000, out = [];
	for (let o = 0; ; o += PAGE) {
		let q = sb.from(table).select(cols).order(order, { ascending: true }).range(o, o + PAGE - 1);
		if (filter) q = filter(q);
		const { data, error } = await q;
		if (error) throw new Error(`${table}: ${error.message}`);
		out.push(...(data ?? []));
		if ((data ?? []).length < PAGE) break;
		if (o && o % 20000 === 0) process.stdout.write(`\r  ${table}: ${out.length.toLocaleString()}...   `);
	}
	return out;
}

const BATCH = 2000, PARALLEL = 4;
const TRANSIENT = /fetch failed|network|timeout|ECONN|EAI_AGAIN|socket/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function upsertAll(table, rows, conflict) {
	if (!rows.length) return;
	const batches = [];
	for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
	const queue = batches.slice();
	let done = 0;
	const worker = async () => {
		for (;;) {
			const batch = queue.shift();
			if (!batch) return;
			for (let attempt = 0; ; attempt++) {
				const { error } = await sb.from(table).upsert(batch, { onConflict: conflict, defaultToNull: false });
				if (!error) break;
				if (attempt >= 4 || !TRANSIENT.test(error.message ?? '')) throw new Error(`${table}: ${error.message}`);
				await sleep(500 * 2 ** attempt);
			}
			done += batch.length;
			process.stdout.write(`\r  ${table}: ${done.toLocaleString()}/${rows.length.toLocaleString()}    `);
		}
	};
	await Promise.all(Array.from({ length: PARALLEL }, worker));
	process.stdout.write('\n');
}

async function main() {
	// 1. Whole corpus of films -> per-film percentiles.
	console.log('Reading credit_films (full corpus)...');
	const filmRows = await readAll('credit_films', 'tmdb_id, title, release_year, vote_count, revenue, countries', 'tmdb_id');
	process.stdout.write('\n');
	const films = filmRows.map((f) => ({
		id: f.tmdb_id, title: f.title, year: f.release_year, vote_count: f.vote_count ?? 0, revenue: f.revenue ?? 0, countries: f.countries ?? [],
	}));
	const filmById = new Map(films.map((f) => [f.id, f]));
	const reachPct = eraPercentiles(films, 'vote_count', false);
	const grossPct = eraPercentiles(films, 'revenue', true);

	console.log('Writing per-film percentiles...');
	const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
	await upsertAll(
		'credit_films',
		films.map((f) => ({ tmdb_id: f.id, title: f.title, reach_pct: r3(reachPct.scores.get(f.id)), gross_pct: r3(grossPct.scores.get(f.id)) })),
		'tmdb_id',
	);

	// 2. People on watched films -> career enrichment. (Only people you've
	//    actually watched can appear in the network; the add-path enriches any new
	//    ones as films are logged.)
	console.log('Reading watched film ids...');
	const watched = await readAll('watched', 'movies!inner(tmdb_id)', 'movie_id');
	const watchedTmdb = [...new Set(watched.map((w) => w.movies?.tmdb_id).filter(Boolean))];

	console.log('Reading credits on watched films...');
	const peopleIds = new Set();
	for (let i = 0; i < watchedTmdb.length; i += 300) {
		const rows = await readAll('credits', 'person_id', 'person_id', (q) => q.in('film_id', watchedTmdb.slice(i, i + 300)));
		for (const r of rows) peopleIds.add(r.person_id);
	}
	const ids = [...peopleIds];
	console.log(`  ${ids.length.toLocaleString()} distinct watched people.`);

	console.log('Reading names + filmographies...');
	const nameById = new Map();
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await readAll('credit_people', 'tmdb_id, name', 'tmdb_id', (q) => q.in('tmdb_id', ids.slice(i, i + 500)));
		for (const r of rows) nameById.set(r.tmdb_id, r.name);
	}
	const filmsByPerson = new Map(ids.map((id) => [id, new Set()]));
	for (let i = 0; i < ids.length; i += 300) {
		const rows = await readAll('credits', 'person_id, film_id', 'film_id', (q) => q.in('person_id', ids.slice(i, i + 300)));
		for (const r of rows) filmsByPerson.get(r.person_id)?.add(r.film_id);
		process.stdout.write(`\r  ${Math.min(i + 300, ids.length)}/${ids.length}   `);
	}
	process.stdout.write('\n');

	console.log('Deriving region / era / prominence...');
	const r2 = (v) => Math.round(v * 100) / 100;
	const now = new Date().toISOString();
	const rows = ids.map((id) => {
		const filmIds = filmsByPerson.get(id) ?? new Set();
		let reachSum = 0, reachN = 0, grossSum = 0, grossN = 0;
		for (const fid of filmIds) {
			const rp = reachPct.scores.get(fid);
			if (rp != null) { reachSum += rp; reachN++; }
			const gp = grossPct.scores.get(fid);
			if (gp != null) { grossSum += gp; grossN++; }
		}
		const cp = countryProfile(filmIds, filmById);
		return {
			tmdb_id: id,
			name: nameById.get(id) ?? `#${id}`,
			region: cp.dominant,
			region_list: cp.members,
			era: careerEra(filmIds, filmById),
			reach: r2(shrunkMean(reachSum, reachN, reachPct.prior) * filmIds.size),
			hit: r2(shrunkMean(grossSum, grossN, grossPct.prior)),
			enriched_at: now,
		};
	});
	console.log('Writing per-person enrichment...');
	await upsertAll('credit_people', rows, 'tmdb_id');

	// 3. Stable config for the app (legends + priors it must not recompute).
	const config = {
		generated: now,
		roles: ROLES,
		roleShareFloor: ROLE_SHARE_FLOOR,
		reachPrior: reachPct.prior,
		grossPrior: grossPct.prior,
		colorModes: [
			{ key: 'role', label: 'Role', field: null, note: 'Two substantial roles split the node.', legend: ROLES.map((r) => ({ label: r.label, light: r.color, dark: r.color })) },
			{ key: 'country', label: 'Where they work', field: 'country', filterField: 'countryList', note: `Coloured by where most of their films were made; filters match any country they have ${COUNTRY_MIN_FILMS}+ films in. Four colours reused down the list -- filter to read a specific one.`, legend: regionLegend() },
			{ key: 'era', label: 'Era of their career', field: 'era', note: 'The era containing the median year of their whole filmography.', legend: eraLegend() },
		],
	};
	await mkdir(path.dirname(CONFIG_OUT), { recursive: true });
	await writeFile(CONFIG_OUT, `${JSON.stringify(config, null, '\t')}\n`);
	console.log(`Wrote ${CONFIG_OUT}. Enriched ${rows.length.toLocaleString()} people; priors reach=${reachPct.prior.toFixed(3)} gross=${grossPct.prior.toFixed(3)}.`);
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
