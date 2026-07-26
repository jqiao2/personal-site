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
/** Share of a person's credits a role needs before it colours their node. */
const ROLE_SHARE_FLOOR = Number.parseFloat(opt('role-share', '0.25'));
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
			revenue: f.revenue ?? 0,
			countries: f.countries ?? [],
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
		all('credit_films', 'tmdb_id,title,release_year,vote_count,revenue,countries', 'tmdb_id'),
		all('credit_people', 'tmdb_id,name', 'tmdb_id'),
		all('credits', 'film_id,person_id,role,billing', 'film_id'),
	]);

	const nameById = new Map(peopleRows.map((p) => [p.tmdb_id, p.name]));
	const byFilm = new Map(
		filmRows.map((f) => [
			f.tmdb_id,
			{
				id: f.tmdb_id,
				title: f.title,
				year: f.release_year,
				vote_count: f.vote_count,
				revenue: f.revenue ?? 0,
				countries: f.countries ?? [],
				credits: [],
			},
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
// Colour dimensions
// ---------------------------------------------------------------------------

/**
 * The countries a person mostly works in — the seven largest in this corpus by
 * number of graphed people, covering ~90% of them, plus a neutral catch-all.
 *
 * Seven is where the colours stop being safely separable. A network graph is an
 * "all pairs" surface (any two nodes can end up adjacent), and under that test
 * this set is the largest that still clears the colour-blind and normal-vision
 * separation floors — verified with the dataviz validator, which rejected a
 * Tableau-10-style ten (green↔red at ΔE 0.7 for deutan viewers, i.e. identical)
 * and every eighth hue tried. The base is Okabe-Ito, designed for exactly this.
 *
 * One set serves both themes rather than two selected ramps: Okabe-Ito is built
 * to hold up on light and dark alike, and here it keeps a country's colour
 * stable when the viewer's theme flips. On the dark surface three of these sit
 * above the usual lightness band — bright, which at a 1–6px node radius helps
 * rather than hurts. The legend and the details panel name the country, so hue
 * never carries identity alone.
 *
 * Colour is bound to the country, never to its rank, so adding data later can't
 * repaint anyone.
 */
const COUNTRIES = [
	{ code: 'US', label: 'United States', color: '#0072B2' },
	{ code: 'FR', label: 'France', color: '#D55E00' },
	{ code: 'GB', label: 'United Kingdom', color: '#009E73' },
	{ code: 'IT', label: 'Italy', color: '#CC79A7' },
	{ code: 'JP', label: 'Japan', color: '#E69F00' },
	{ code: 'CA', label: 'Canada', color: '#56B4E9' },
	{ code: 'IN', label: 'India', color: '#B03060' },
	{ code: null, label: 'Elsewhere', color: '#9A9A95' },
];
const COUNTRY_OF = new Map(COUNTRIES.flatMap((c, i) => (c.code ? [[c.code, i]] : [])));
const OTHER_COUNTRY = COUNTRIES.findIndex((c) => !c.code);

/**
 * Eras of film history, by the midpoint of a person's career.
 *
 * A single-hue ramp is the textbook encoding for ordered data, but five steps of
 * one blue are indistinguishable on a 3px dot — the whole point of the colour is
 * lost. So this walks a viridis-style path instead, which still reads as ordered
 * (lightness moves monotonically through the sequence) while separating the
 * steps by hue as well. It clears the colour-blind and normal-vision floors in
 * both modes, which the single-hue version could not do at five steps.
 *
 * Here the two themes DO get their own steps: the ramp has to run away from
 * whichever surface it sits on, so light mode darkens through the sequence and
 * dark mode brightens through it.
 *
 * Boundaries follow the conventional turning points — the arrival of sound, the
 * collapse of the studio system, and the post-Jaws blockbuster era.
 */
const ERAS = [
	{ key: 'silent', label: 'Silent, to 1928', until: 1928, light: '#7AD151', dark: '#FDE725' },
	{ key: 'studio', label: 'Studio era, 1929–59', until: 1959, light: '#22A884', dark: '#5EC962' },
	{ key: 'newhw', label: 'New Hollywood, 1960–80', until: 1980, light: '#2A788E', dark: '#21918C' },
	{ key: 'blockbuster', label: 'Blockbuster, 1981–99', until: 1999, light: '#414487', dark: '#3B528B' },
	{ key: 'modern', label: 'Modern, 2000–', until: Infinity, light: '#440154', dark: '#7E6FC4' },
];

/** The country a person is placed in: the one most of their films came from.
 * Anything outside the seven named falls to the catch-all.
 *
 * Every production country on a film counts, each worth 1/n of that film — NOT
 * just the first listed. TMDB returns production_countries in alphabetical
 * order rather than by significance, so "first" is not "primary": it would hand
 * every Italian-French co-production to France (FR sorts before IT) and every
 * US-Canadian one to Canada. Splitting the film's weight across its countries
 * removes that bias and lets a career of outright Italian films outvote the
 * co-productions, which is how Fellini ends up Italian rather than French. */
function dominantCountry(filmIds, filmById) {
	const tally = new Map();
	for (const id of filmIds) {
		const codes = filmById.get(id)?.countries ?? [];
		if (!codes.length) continue;
		const share = 1 / codes.length;
		for (const code of codes) tally.set(code, (tally.get(code) ?? 0) + share);
	}
	if (!tally.size) return OTHER_COUNTRY;
	let bestCode = null;
	let bestN = -1;
	for (const [code, n] of tally) {
		if (n > bestN) {
			bestN = n;
			bestCode = code;
		}
	}
	return COUNTRY_OF.get(bestCode) ?? OTHER_COUNTRY;
}

/** The era a person sits in, by the median year of their filmography — the
 * midpoint of a career, rather than its first or busiest moment. */
function careerEra(filmIds, filmById) {
	const years = [...filmIds]
		.map((id) => filmById.get(id)?.year)
		.filter((y) => y)
		.sort((a, b) => a - b);
	if (!years.length) return ERAS.length - 1;
	const median = years[Math.floor(years.length / 2)];
	return ERAS.findIndex((e) => median <= e.until);
}

// ---------------------------------------------------------------------------
// Prominence metrics
// ---------------------------------------------------------------------------

/**
 * Era adjustment.
 *
 * Both prominence signals TMDB offers are badly era-skewed. `revenue` is nominal
 * dollars and present for only ~54% of the corpus (28% of 1920s films, 65% of
 * 1980s). `vote_count` is complete, but counts votes cast *today*, so a 2015
 * film out-polls a 1925 landmark by an order of magnitude. Ranked raw, either
 * one collapses into "worked recently" — Chaplin below a single franchise entry.
 *
 * So a film is scored by its PERCENTILE among films released around the same
 * time: "how big was this, for its moment", on 0..1. The comparison window is
 * ±2 years, widened until it holds at least MIN_WINDOW films so that thin early
 * years borrow from their neighbours.
 *
 * Returns per-film percentiles plus the corpus mean, used as a shrinkage prior.
 */
const MIN_WINDOW = 30;
/** Pseudo-observations pulling a thin sample toward the corpus mean. */
const SHRINKAGE = 3;

function eraPercentiles(films, field, requirePositive) {
	const value = (f) => f[field] ?? 0;
	const usable = (f) => f.year && (!requirePositive || value(f) > 0);

	const byYear = new Map();
	for (const f of films) {
		if (!usable(f)) continue;
		if (!byYear.has(f.year)) byYear.set(f.year, []);
		byYear.get(f.year).push(value(f));
	}
	for (const arr of byYear.values()) arr.sort((a, b) => a - b);

	// Memoised comparison window per year: widen ±1 until it has enough films.
	const windows = new Map();
	const windowFor = (year) => {
		let cached = windows.get(year);
		if (cached) return cached;
		let span = 2;
		let merged = [];
		for (;;) {
			merged = [];
			for (let y = year - span; y <= year + span; y++) {
				const arr = byYear.get(y);
				if (arr) merged.push(...arr);
			}
			if (merged.length >= MIN_WINDOW || span > 60) break;
			span++;
		}
		merged.sort((a, b) => a - b);
		windows.set(year, merged);
		return merged;
	};

	const scores = new Map();
	let total = 0;
	let n = 0;
	for (const f of films) {
		if (!usable(f)) {
			scores.set(f.id, null);
			continue;
		}
		const w = windowFor(f.year);
		if (w.length < 2) {
			scores.set(f.id, null);
			continue;
		}
		const v = value(f);
		let lo = 0;
		let hi = w.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (w[mid] < v) lo = mid + 1;
			else hi = mid;
		}
		const p = lo / (w.length - 1);
		scores.set(f.id, p);
		total += p;
		n++;
	}
	return { scores, prior: n ? total / n : 0.5 };
}

/** Shrunk mean of a person's per-film percentiles: a thin sample is pulled
 * toward the corpus mean so one lucky data point can't outrank a long career. */
function shrunkMean(sum, count, prior) {
	return (sum + SHRINKAGE * prior) / (count + SHRINKAGE);
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

	// 1b. Prominence metrics, summed over each person's distinct films. `votes`
	//     (audience reach) has full coverage; `gross` is era-adjusted and only
	//     defined for the films TMDB has a revenue figure for.
	const filmById = new Map(films.map((f) => [f.id, f]));
	const reachPct = eraPercentiles(films, 'vote_count', false);
	const grossPct = eraPercentiles(films, 'revenue', true);
	const withRevenue = films.filter((f) => f.revenue > 0).length;
	console.log(
		`  era-adjusted against a ±2-year window: vote_count on all films, ` +
			`revenue on the ${((withRevenue / films.length) * 100).toFixed(0)}% that report one.`,
	);

	for (const p of people.values()) {
		let reachSum = 0;
		let reachN = 0;
		let grossSum = 0;
		p.grossFilms = 0;
		for (const id of p.films) {
			const f = filmById.get(id);
			if (!f) continue;
			const rp = reachPct.scores.get(id);
			if (rp != null) {
				reachSum += rp;
				reachN++;
			}
			const gp = grossPct.scores.get(id);
			if (gp != null) {
				grossSum += gp;
				p.grossFilms++;
			}
		}
		// reach: typical standing among contemporaries, scaled by filmography —
		// the closest thing here to "how well known". Volume is part of fame, so
		// its correlation with film count (~0.97) is the point, not a defect.
		p.reach = shrunkMean(reachSum, reachN, reachPct.prior) * p.films.size;
		// hit: per-film, deliberately NOT scaled. That keeps it independent of
		// volume (r=0.27 with film count) so it answers a different question —
		// were their films big for their time, however many they made.
		p.hit = shrunkMean(grossSum, p.grossFilms, grossPct.prior);
		p.country = dominantCountry(p.films, filmById);
		p.era = careerEra(p.films, filmById);
	}

	// 2. Keep people who clear the threshold in at least one role. Their roles for
	//    colouring are exactly the ones they cleared — a director with 40 acting
	//    credits and 6 directing credits reads as both; one with 2 doesn't.
	const qualified = new Map();
	for (const [id, p] of people) {
		const cleared = roles.map((r, i) => (p.counts[i] >= r.min_films ? i : -1)).filter((i) => i >= 0);
		if (!cleared.length) continue;

		// Clearing a threshold isn't enough to be *shown* as that role. An actor
		// with 120 roles who directed 5 films is an actor, not an actor-director —
		// so a role also has to account for ROLE_SHARE_FLOOR of the person's
		// credits to earn a slice of the node. If that would leave nothing (every
		// cleared role is a small share), keep the largest so the node still has
		// a colour.
		const totalCredits = p.counts.reduce((a, b) => a + b, 0);
		const major = cleared.filter((i) => p.counts[i] / totalCredits >= ROLE_SHARE_FLOOR);
		const qroles = major.length
			? major
			: [cleared.reduce((best, i) => (p.counts[i] > p.counts[best] ? i : best), cleared[0])];
		qualified.set(id, { ...p, qroles });
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
			// Rounded: two decimals is far finer than these metrics' real
			// precision, and this ships to the browser.
			reach: Math.round(p.reach * 100) / 100,
			hit: Math.round(p.hit * 1000) / 1000,
			grossFilms: p.grossFilms,
			...Object.fromEntries(roles.map((r, i) => [`n_${r.role}`, p.counts[i]])),
			// Bitmask of the roles actually drawn. The client must not re-derive
			// this from the counts — that would miss the share floor above.
			roleMask: p.qroles.reduce((m, i) => m | (1 << i), 0),
			roles: p.qroles.map((i) => roles[i].role).join('+'),
			country: p.country,
			era: p.era,
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
		// nodeFields/edgeFields document the positional arrays below; the client
		// derives its indices from nodeFields rather than hard-coding offsets.
		roles: roles.map((r) => ({ role: r.role, label: r.label, color: r.color, minFilms: r.min_films })),
		// Sizing options offered in the UI. Deliberately only three, and only ones
		// that answer different questions: anything built by scaling a per-film
		// score by filmography ends up ~0.97 correlated with `films`.
		metrics: [
			{
				key: 'reach',
				label: 'Prominence',
				note: 'How each film ranked among its own contemporaries, summed over a career. Era-adjusted, so silent-era figures are not buried by modern vote counts.',
			},
			{ key: 'films', label: 'Films credited', note: 'Raw output, ignoring how widely seen any of it was.' },
			{
				key: 'hit',
				label: 'Typical hit size',
				note: `Era-adjusted box office, per film rather than per career — big films however few they made. Independent of output (r=0.27). Only ${((withRevenue / films.length) * 100).toFixed(0)}% of films report revenue.`,
			},
		],
		roleShareFloor: ROLE_SHARE_FLOOR,
		// What a node's colour can encode. `role` splits a node into equal slices
		// (the only multi-valued one); region and era are single-valued, so the
		// client paints every slice the same colour. Each carries both mode's
		// steps — dark is a selected palette, not an automatic flip.
		colorModes: [
			{
				key: 'role',
				label: 'Role',
				field: null,
				note: 'People who hold two roles substantially are split half-and-half.',
				legend: roles.map((r) => ({ label: r.label, light: r.color, dark: r.color })),
			},
			{
				key: 'country',
				label: 'Where they work',
				field: 'country',
				note: 'The country most of their films were produced in. Seven is the most that stays separable for colour-blind viewers at this node size, so smaller industries share a neutral.',
				legend: COUNTRIES.map((c) => ({ label: c.label, light: c.color, dark: c.color })),
			},
			{
				key: 'era',
				label: 'Era of their career',
				field: 'era',
				note: 'The era containing the median year of their filmography. Ordered, so the colours run in sequence rather than being unrelated.',
				legend: ERAS.map((e) => ({ label: e.label, light: e.light, dark: e.dark })),
			},
		],
		nodeFields: [
			'tmdbId', 'name', 'x', 'y',
			'films', 'reach', 'hit', 'grossFilms', 'roleMask', 'country', 'era',
			...roles.map((r) => `n_${r.role}`),
		],
		edgeFields: ['source', 'target', 'weight'],
		nodes: ids.map((id) => {
			const a = graph.getNodeAttributes(id);
			return [
				Number(id), a.label, r2(a.x), r2(a.y),
				a.films, a.reach, a.hit, a.grossFilms, a.roleMask, a.country, a.era,
				...roles.map((r) => a[`n_${r.role}`]),
			];
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
	const at = (field) => payload.nodeFields.indexOf(field);
	const iMask = at('roleMask');
	const held = (n) => payload.roles.filter((_r, i) => n[iMask] & (1 << i));
	const multi = payload.nodes.filter((n) => held(n).length > 1);
	const cleared = payload.nodes.filter(
		(n) => payload.roles.filter((r, i) => n[at(`n_${r.role}`)] >= r.minFilms).length > 1,
	).length;
	console.log(
		`${multi.length.toLocaleString()} people are drawn split-colour ` +
			`(${cleared.toLocaleString()} clear two thresholds, but only these hold ` +
			`>=${(ROLE_SHARE_FLOOR * 100).toFixed(0)}% of their credits in each).`,
	);
	for (const n of multi.slice(0, 4)) {
		console.log(`  e.g. ${n[1]} — ${held(n).map((r) => r.label.toLowerCase()).join(' + ')}`);
	}

	// Print each metric's top few — the cheapest check that the ranking is sane,
	// and that era adjustment hasn't quietly become "worked after 1980".
	for (const m of payload.metrics) {
		const i = at(m.key);
		const top = [...payload.nodes].sort((a, b) => b[i] - a[i]).slice(0, 5);
		const fmt = (n) => (m.key === 'gross' ? n[i].toFixed(0) : n[i].toLocaleString());
		console.log(`top by ${m.label}: ${top.map((n) => `${n[1]} (${fmt(n)})`).join(', ')}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
