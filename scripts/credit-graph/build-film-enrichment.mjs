// Precompute the career-wide enrichment the watched-films credit network needs:
// each watched person's region / era / prominence, derived from the credit_*
// tables with the SAME logic the corpus page uses (scripts/credit-graph/derive.mjs,
// copied from build.mjs). Also emits a per-watched-film credit map so the live
// builder (src/lib/films.ts) can assemble the graph on exact TMDB person ids
// instead of ambiguous names.
//
// Output (committed, imported by films.ts): src/data/credit-enrichment.json
//   config  — roles, roleShareFloor, colorModes (role/region/era legends)
//   byFilm  — { <film tmdb_id>: [[personId, roleIdx], …] } for watched films
//   byId    — { <person tmdb_id>: [name, country, countryList, era, reach, hit] }
//
// Rerun after backfill-watched.mjs, or whenever the watch log gains films whose
// people aren't covered yet. Reads live tables, writes a file — cheap, no TMDB.
//
// Usage: node --env-file=.env scripts/credit-graph/build-film-enrichment.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
	countryProfile, careerEra, eraPercentiles, shrunkMean, regionLegend, eraLegend, COUNTRY_MIN_FILMS,
} from './derive.mjs';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ROLES = [
	{ role: 'actor', label: 'Actor', color: '#e0574f' },
	{ role: 'director', label: 'Director', color: '#4a8fd4' },
	{ role: 'composer', label: 'Composer', color: '#3fa87a' },
];
const ROLE_IDX = { actor: 0, director: 1, composer: 2 };
const ROLE_SHARE_FLOOR = 0.25;
const OUT = path.join('src', 'data', 'credit-enrichment.json');

async function readAll(table, cols, order, filter) {
	const PAGE = 1000, out = [];
	for (let o = 0; ; o += PAGE) {
		let q = sb.from(table).select(cols).order(order, { ascending: true }).range(o, o + PAGE - 1);
		if (filter) q = filter(q);
		const { data, error } = await q;
		if (error) throw new Error(`${table}: ${error.message}`);
		out.push(...(data ?? []));
		if ((data ?? []).length < PAGE) break;
		if (o && o % 20000 === 0) process.stdout.write(`\r  ${table}: ${out.length.toLocaleString()}…   `);
	}
	return out;
}

async function main() {
	console.log('Reading watched film ids…');
	const watched = await readAll('watched', 'movies!inner(tmdb_id)', 'movie_id');
	const watchedTmdb = [...new Set(watched.map((w) => w.movies?.tmdb_id).filter(Boolean))];
	console.log(`  ${watchedTmdb.length.toLocaleString()} watched films.`);

	// byFilm + the set of people on watched films. Chunk the film-id filter to
	// keep each request's URL sane.
	console.log('Reading credits on watched films…');
	const byFilm = {};
	const peopleIds = new Set();
	for (let i = 0; i < watchedTmdb.length; i += 300) {
		const chunk = watchedTmdb.slice(i, i + 300);
		const rows = await readAll('credits', 'film_id, person_id, role', 'person_id', (q) => q.in('film_id', chunk));
		for (const r of rows) {
			const ri = ROLE_IDX[r.role];
			if (ri === undefined) continue;
			(byFilm[r.film_id] ??= []).push([r.person_id, ri]);
			peopleIds.add(r.person_id);
		}
	}
	console.log(`  ${Object.keys(byFilm).length.toLocaleString()} films, ${peopleIds.size.toLocaleString()} distinct people.`);

	// Names for those people.
	console.log('Reading names…');
	const nameById = new Map();
	const ids = [...peopleIds];
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await readAll('credit_people', 'tmdb_id, name', 'tmdb_id', (q) => q.in('tmdb_id', ids.slice(i, i + 500)));
		for (const r of rows) nameById.set(r.tmdb_id, r.name);
	}

	// The whole corpus of films: percentile windows are global, and each person's
	// career country/era spans their full filmography, not just watched films.
	console.log('Reading credit_films (full corpus)…');
	const filmRows = await readAll('credit_films', 'tmdb_id, release_year, vote_count, revenue, countries', 'tmdb_id');
	process.stdout.write('\n');
	const films = filmRows.map((f) => ({
		id: f.tmdb_id, year: f.release_year, vote_count: f.vote_count ?? 0, revenue: f.revenue ?? 0, countries: f.countries ?? [],
	}));
	const filmById = new Map(films.map((f) => [f.id, f]));
	const reachPct = eraPercentiles(films, 'vote_count', false);
	const grossPct = eraPercentiles(films, 'revenue', true);

	// Each watched person's full corpus filmography.
	console.log('Reading full filmographies for watched people…');
	const filmsByPerson = new Map(ids.map((id) => [id, new Set()]));
	for (let i = 0; i < ids.length; i += 300) {
		const rows = await readAll('credits', 'person_id, film_id', 'film_id', (q) => q.in('person_id', ids.slice(i, i + 300)));
		for (const r of rows) filmsByPerson.get(r.person_id)?.add(r.film_id);
		process.stdout.write(`\r  ${Math.min(i + 300, ids.length)}/${ids.length}   `);
	}
	process.stdout.write('\n');

	console.log('Deriving region / era / prominence…');
	const r2 = (v) => Math.round(v * 100) / 100;
	const byId = {};
	for (const id of ids) {
		const filmIds = filmsByPerson.get(id) ?? new Set();
		let reachSum = 0, reachN = 0, grossSum = 0, grossN = 0;
		for (const fid of filmIds) {
			const rp = reachPct.scores.get(fid);
			if (rp != null) { reachSum += rp; reachN++; }
			const gp = grossPct.scores.get(fid);
			if (gp != null) { grossSum += gp; grossN++; }
		}
		const reach = shrunkMean(reachSum, reachN, reachPct.prior) * filmIds.size;
		const hit = shrunkMean(grossSum, grossN, grossPct.prior);
		const cp = countryProfile(filmIds, filmById);
		const era = careerEra(filmIds, filmById);
		byId[id] = [nameById.get(id) ?? `#${id}`, cp.dominant, cp.members, era, r2(reach), r2(hit * 1000) / 1000];
	}

	const payload = {
		generated: new Date().toISOString(),
		config: {
			roles: ROLES,
			roleShareFloor: ROLE_SHARE_FLOOR,
			colorModes: [
				{ key: 'role', label: 'Role', field: null, note: 'Two substantial roles split the node.', legend: ROLES.map((r) => ({ label: r.label, light: r.color, dark: r.color })) },
				{ key: 'country', label: 'Where they work', field: 'country', filterField: 'countryList', note: `Coloured by where most of their films were made; filters match any country they have ${COUNTRY_MIN_FILMS}+ films in. Four colours reused down the list — filter to read a specific one.`, legend: regionLegend() },
				{ key: 'era', label: 'Era of their career', field: 'era', note: 'The era containing the median year of their whole filmography.', legend: eraLegend() },
			],
		},
		byFilm,
		byId,
	};
	await mkdir(path.dirname(OUT), { recursive: true });
	await writeFile(OUT, JSON.stringify(payload));
	const mb = (Buffer.byteLength(JSON.stringify(payload)) / 1048576).toFixed(2);
	console.log(`Wrote ${OUT} (${mb} MB): ${Object.keys(byId).length.toLocaleString()} people, ${Object.keys(byFilm).length.toLocaleString()} films.`);
	// Cheapest sanity check: a few well-known people's derived region/era.
	for (const nm of ['Toshirō Mifune', 'Martin Scorsese', 'Wong Kar-wai', 'Greta Gerwig']) {
		const hit = Object.values(byId).find((v) => v[0] === nm);
		if (hit) console.log(`  ${nm}: country#${hit[1]} era#${hit[3]} reach ${hit[4]} hit ${hit[5]}`);
	}
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
