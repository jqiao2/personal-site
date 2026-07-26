// Stage 3 of the credit-graph pipeline: credits -> filtered, laid-out network.
//
// Projects the bipartite person<->film credit table into a one-mode collaboration
// network (nodes = people, edge weight = films shared), applies the per-role
// thresholds, runs ForceAtlas2 headlessly so the page loads an already-settled
// layout, and writes two artifacts:
//
//   public/data/credit-network.json  — what the /projects/credit-network page loads
//   public/data/credit-network.gexf  — openable in actual Gephi
//
// Reads from the NDJSON cache by default (always available, no DB round-trip);
// `--from=db` reads the same data back out of Supabase instead, which is the
// path that exercises the tables migration 0015 creates.
//
// Usage:
//   node --env-file=.env scripts/credit-graph/build.mjs [options]
//     --from=cache|db     Data source (default cache)
//     --min-actor=<n>     Films needed to appear as an actor    (default 10)
//     --min-director=<n>  Films needed to appear as a director  (default 5)
//     --min-composer=<n>  Films needed to appear as a composer  (default 3)
//     --min-edge=<n>      Shared films needed for an edge       (default 2)
//     --iterations=<n>    ForceAtlas2 iterations                (default 400)
//     --keep-isolates     Keep people left with no surviving edge

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import gexf from 'graphology-gexf';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const num = (name, fallback) => Number.parseInt(opt(name, String(fallback)), 10);

const FROM = opt('from', 'cache');
const MIN_EDGE = num('min-edge', 2);
const ITERATIONS = num('iterations', 400);
const KEEP_ISOLATES = flag('keep-isolates');

/** Role presentation + thresholds. Mirrors the credit_roles seed rows in
 * migration 0015; `--from=db` replaces this with whatever the table actually
 * says, so the DB stays the source of truth when it is the source of data. */
const ROLES = [
	{ role: 'actor', label: 'Actor', color: '#e0574f', min_films: num('min-actor', 10), sort_order: 1 },
	{ role: 'director', label: 'Director', color: '#4a8fd4', min_films: num('min-director', 5), sort_order: 2 },
	{ role: 'composer', label: 'Composer', color: '#3fa87a', min_films: num('min-composer', 3), sort_order: 3 },
];

const CACHE_FILE = path.join('scripts', '.cache', 'credit-graph', 'films.ndjson');
const OUT_DIR = path.join('public', 'data');

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Shape both sources produce: films[] with a flat credit list, and the role
 * table. Films carry only what the graph needs (title/year for edge tooltips). */

async function loadFromCache() {
	const films = [];
	const rl = createInterface({ input: createReadStream(CACHE_FILE), crlfDelay: Infinity });
	const seen = new Set();
	for await (const line of rl) {
		if (!line.trim()) continue;
		let f;
		try {
			f = JSON.parse(line);
		} catch {
			continue;
		}
		if (seen.has(f.id)) continue;
		seen.add(f.id);
		films.push({
			id: f.id,
			title: f.title,
			year: f.year,
			vote_count: f.vote_count ?? 0,
			credits: f.credits ?? [],
		});
	}
	return { films, roles: ROLES };
}

async function loadFromDb() {
	const { createClient } = await import('@supabase/supabase-js');
	const SB_URL = process.env.SUPABASE_URL;
	const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!SB_URL || !SB_KEY) throw new Error('--from=db needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
	const supabase = createClient(SB_URL, SB_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});

	/** Page past PostgREST's 1000-row response cap. */
	async function all(table, columns, order) {
		const PAGE = 1000;
		const out = [];
		for (let offset = 0; ; offset += PAGE) {
			const { data, error } = await supabase
				.from(table)
				.select(columns)
				.order(order, { ascending: true })
				.range(offset, offset + PAGE - 1);
			if (error) throw new Error(`${table}: ${error.message}`);
			out.push(...(data ?? []));
			if ((data ?? []).length < PAGE) break;
			if (offset % 50000 === 0 && offset) process.stdout.write(`\r  ${table}: ${out.length.toLocaleString()}…   `);
		}
		if (out.length > PAGE) process.stdout.write(`\r  ${table}: ${out.length.toLocaleString()}      \n`);
		return out;
	}

	const [roles, filmRows, peopleRows, creditRows] = await Promise.all([
		all('credit_roles', 'role,label,color,min_films,sort_order', 'sort_order'),
		all('credit_films', 'tmdb_id,title,release_year,vote_count', 'tmdb_id'),
		all('credit_people', 'tmdb_id,name', 'tmdb_id'),
		all('credits', 'film_id,person_id,role,billing', 'film_id'),
	]);

	const nameById = new Map(peopleRows.map((p) => [p.tmdb_id, p.name]));
	const byFilm = new Map(
		filmRows.map((f) => [
			f.tmdb_id,
			{ id: f.tmdb_id, title: f.title, year: f.release_year, vote_count: f.vote_count, credits: [] },
		]),
	);
	for (const c of creditRows) {
		byFilm.get(c.film_id)?.credits.push({
			id: c.person_id,
			name: nameById.get(c.person_id) ?? `#${c.person_id}`,
			role: c.role,
			billing: c.billing,
		});
	}

	// CLI overrides still win, so you can explore thresholds without a DB write.
	const merged = roles.map((r) => {
		const override = ROLES.find((d) => d.role === r.role);
		const flagGiven = args.some((a) => a.startsWith(`--min-${r.role}=`));
		return { ...r, min_films: flagGiven && override ? override.min_films : r.min_films };
	});
	return { films: [...byFilm.values()], roles: merged.length ? merged : ROLES };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

async function main() {
	console.log(`Loading credits from ${FROM}…`);
	const { films, roles } = FROM === 'db' ? await loadFromDb() : await loadFromCache();
	roles.sort((a, b) => a.sort_order - b.sort_order);
	const roleIndex = new Map(roles.map((r, i) => [r.role, i]));

	console.log(
		`${films.length.toLocaleString()} films. Thresholds: ` +
			`${roles.map((r) => `${r.label} >= ${r.min_films}`).join(', ')}, edge >= ${MIN_EDGE} shared films.`,
	);

	// 1. Per-person film counts, per role and distinct.
	const people = new Map(); // id -> { name, counts[], films:Set }
	for (const f of films) {
		for (const c of f.credits) {
			const ri = roleIndex.get(c.role);
			if (ri === undefined) continue; // a role we no longer graph
			let p = people.get(c.id);
			if (!p) {
				p = { name: c.name, counts: new Array(roles.length).fill(0), films: new Set() };
				people.set(c.id, p);
			}
			p.counts[ri]++;
			p.films.add(f.id);
		}
	}
	console.log(`  ${people.size.toLocaleString()} distinct people credited.`);

	// 2. Keep people who clear the threshold in at least one role. Their roles for
	//    colouring are exactly the ones they cleared — a director with 40 acting
	//    credits and 6 directing credits reads as both; one with 2 doesn't.
	const qualified = new Map();
	for (const [id, p] of people) {
		const qroles = roles.map((r, i) => (p.counts[i] >= r.min_films ? i : -1)).filter((i) => i >= 0);
		if (qroles.length) qualified.set(id, { ...p, qroles });
	}
	const perRole = roles.map((r, i) => `${[...qualified.values()].filter((p) => p.qroles.includes(i)).length.toLocaleString()} ${r.label.toLowerCase()}s`);
	console.log(`  ${qualified.size.toLocaleString()} clear a threshold (${perRole.join(', ')}).`);

	// 3. Project to co-credit edges: every pair of qualifying people on a film
	//    shares that film. Weight is the count of shared films, regardless of the
	//    roles involved — that is what "collaboration count" means here.
	const edges = new Map(); // "lo:hi" -> weight
	for (const f of films) {
		const on = [...new Set(f.credits.map((c) => c.id))].filter((id) => qualified.has(id));
		for (let i = 0; i < on.length; i++) {
			for (let j = i + 1; j < on.length; j++) {
				const [lo, hi] = on[i] < on[j] ? [on[i], on[j]] : [on[j], on[i]];
				const key = `${lo}:${hi}`;
				edges.set(key, (edges.get(key) ?? 0) + 1);
			}
		}
	}
	console.log(`  ${edges.size.toLocaleString()} co-credit pairs; keeping those with >= ${MIN_EDGE}.`);

	// 4. Build the graph from surviving edges.
	const graph = new Graph({ type: 'undirected' });
	const addNode = (id) => {
		if (graph.hasNode(String(id))) return;
		const p = qualified.get(id);
		graph.addNode(String(id), {
			label: p.name,
			films: p.films.size,
			...Object.fromEntries(roles.map((r, i) => [`n_${r.role}`, p.counts[i]])),
			roles: p.qroles.map((i) => roles[i].role).join('+'),
		});
	};
	for (const [key, weight] of edges) {
		if (weight < MIN_EDGE) continue;
		const [a, b] = key.split(':');
		addNode(Number(a));
		addNode(Number(b));
		graph.addUndirectedEdge(String(a), String(b), { weight });
	}
	if (KEEP_ISOLATES) for (const id of qualified.keys()) addNode(id);

	console.log(`  graph: ${graph.order.toLocaleString()} nodes, ${graph.size.toLocaleString()} edges.`);
	if (graph.order === 0) {
		console.error('Empty graph — thresholds too strict, or the cache is empty.');
		process.exit(1);
	}

	// 5. Seed positions on a circle (FA2 requires x/y and degrades from a random
	//    cloud), then settle with ForceAtlas2.
	const nodes = graph.nodes();
	nodes.forEach((n, i) => {
		const a = (2 * Math.PI * i) / nodes.length;
		graph.setNodeAttribute(n, 'x', Math.cos(a) * 1000);
		graph.setNodeAttribute(n, 'y', Math.sin(a) * 1000);
	});

	console.log(`Running ForceAtlas2 (${ITERATIONS} iterations)…`);
	const started = Date.now();
	const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true, edgeWeightInfluence: 1 };
	forceAtlas2.assign(graph, { iterations: ITERATIONS, settings, getEdgeWeight: 'weight' });
	console.log(`  settled in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

	// 6. Emit. Nodes/edges are positional arrays rather than objects — this file is
	//    shipped to the browser, and the key names would dominate its size.
	const ids = graph.nodes();
	const idx = new Map(ids.map((id, i) => [id, i]));
	const r2 = (v) => Math.round(v * 100) / 100;

	const payload = {
		meta: {
			generated: new Date().toISOString(),
			source: FROM,
			films: films.length,
			people: people.size,
			nodes: graph.order,
			edges: graph.size,
			minEdge: MIN_EDGE,
		},
		// nodeFields/edgeFields document the positional arrays below.
		roles: roles.map((r) => ({ role: r.role, label: r.label, color: r.color, minFilms: r.min_films })),
		nodeFields: ['tmdbId', 'name', 'x', 'y', 'films', ...roles.map((r) => `n_${r.role}`)],
		edgeFields: ['source', 'target', 'weight'],
		nodes: ids.map((id) => {
			const a = graph.getNodeAttributes(id);
			return [Number(id), a.label, r2(a.x), r2(a.y), a.films, ...roles.map((r) => a[`n_${r.role}`])];
		}),
		edges: graph.mapEdges((_e, a, s, t) => [idx.get(s), idx.get(t), a.weight]),
	};

	await mkdir(OUT_DIR, { recursive: true });
	const jsonPath = path.join(OUT_DIR, 'credit-network.json');
	await writeFile(jsonPath, JSON.stringify(payload));

	// GEXF for real Gephi. Give nodes their colour and a size so the file is
	// useful the moment it opens, rather than a grey hairball.
	const colorOf = (a) => {
		const mine = roles.filter((r) => a.roles.split('+').includes(r.role));
		return (mine[0] ?? roles[0]).color;
	};
	const gexfGraph = graph.copy();
	gexfGraph.forEachNode((n, a) => {
		gexfGraph.mergeNodeAttributes(n, { color: colorOf(a), size: Math.sqrt(a.films) });
	});
	const gexfPath = path.join(OUT_DIR, 'credit-network.gexf');
	await writeFile(gexfPath, gexf.write(gexfGraph));

	const mb = (p) => `${(Buffer.byteLength(p) / 1048576).toFixed(2)} MB`;
	console.log(`\nWrote ${jsonPath} (${mb(JSON.stringify(payload))})`);
	console.log(`Wrote ${gexfPath}`);
	// Role counts start at index 5 of each node array, aligned with payload.roles.
	const ROLE_OFFSET = 5;
	const held = (n) => payload.roles.filter((r, i) => n[ROLE_OFFSET + i] >= r.minFilms);
	const multi = payload.nodes.filter((n) => held(n).length > 1);
	console.log(`${multi.length.toLocaleString()} people clear more than one role (drawn as split-colour nodes).`);
	for (const n of multi.slice(0, 5)) {
		console.log(`  e.g. ${n[1]} — ${held(n).map((r) => r.label.toLowerCase()).join(' + ')}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
