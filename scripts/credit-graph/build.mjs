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
//     --min-actor=<n>     Films needed to appear as an actor    (default 5)
//     --min-director=<n>  Films needed to appear as a director  (default 2)
//     --min-composer=<n>  Films needed to appear as a composer  (default 2)
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
	{ role: 'actor', label: 'Actor', color: '#e0574f', min_films: num('min-actor', 5), sort_order: 1 },
	{ role: 'director', label: 'Director', color: '#4a8fd4', min_films: num('min-director', 2), sort_order: 2 },
	{ role: 'composer', label: 'Composer', color: '#3fa87a', min_films: num('min-composer', 2), sort_order: 3 },
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
 * The countries a person works in — every one with ~8+ graphed people, plus a
 * neutral catch-all.
 *
 * FOUR colours, deliberately repeated across the list. This replaces an earlier
 * attempt to give the twelve biggest industries a colour each, which was the
 * wrong goal: it spent the whole colour space chasing unique hues and ended up
 * with a palette whose worst pair was indistinguishable in practice. Reported
 * plainly by a colour-blind reader — the twelve could barely be told apart — and
 * the measurement agrees with them.
 *
 * A network graph is an "all pairs" surface: any two nodes can end up adjacent,
 * so the palette is only as good as its WORST pair, under normal vision and all
 * three colour-blindness types (Machado severity 1.0, distance in OKLab x100):
 *
 *     palette                       normal floor   CVD floor
 *     12 unique hues (previous)         9.6           7.6
 *     8 repeated                       15.6          11.0
 *     6 repeated                       15.6          13.1
 *     5 repeated                       19.5          14.6
 *     4 repeated (current)             27.1          21.3   <- cliff edge
 *
 * Four is where the cliff is: dropping from 5 to 4 buys a 46% wider floor, and
 * going the other way collapses it. 21.3 against the old 7.6 is not a tweak,
 * it is the difference between "these are two colours" and "these are the same
 * colour". The four survive because they separate on LIGHTNESS as much as hue
 * (OKLab L 0.44 / 0.52 / 0.73 / 0.75), and lightness is the channel colour
 * blindness leaves intact — which is exactly why the old purple-heavy set,
 * where four entries sat at L 0.43-0.44, failed.
 *
 * Black and near-white yellow score better still and are excluded anyway: a node
 * has to read on both the light and the dark surface, so the extremes of
 * lightness are unusable no matter how separable they are.
 *
 * What repetition costs: hue no longer identifies a country on its own. It never
 * fully did — twenty-four countries were never going to have twenty-four legible
 * hues — so this makes the honest version explicit. Colour now says "roughly
 * which part of the list", and the legend, the filter list and the details panel
 * carry the actual identity. Filtering to one country is the precise instrument.
 *
 * Assignment cycles in rank order, so the largest industries — the ones that
 * dominate the canvas — never collide with each other.
 */
const NEUTRAL = '#9A9A95';

/** The repeating four, measured above. Ordered so the cycle alternates lightness
 * as well as hue, which keeps consecutive entries apart for a reader who has
 * only lightness to go on. */
const CYCLE = [
	'#E69F00', // orange,     L 0.75
	'#4400DD', // blue-violet, L 0.44
	'#56B4E9', // sky,        L 0.73
	'#B03060', // maroon,     L 0.52
];

/** Every country with at least ~8 graphed people, largest first, plus a
 * catch-all. `also` folds in historical codes.
 *
 * No `color` here: the cycle below assigns one by position, so this list is
 * purely "which countries, in what order". Re-sorting it repaints, which is
 * fine and expected now that hue is a grouping cue rather than an identity —
 * the previous list had to freeze colours per country precisely because hue
 * was doing work it could not actually do. */
const COUNTRY_LIST = [
	{ code: 'US', label: 'United States' },
	{ code: 'FR', label: 'France' },
	{ code: 'GB', label: 'United Kingdom' },
	{ code: 'IT', label: 'Italy' },
	{ code: 'JP', label: 'Japan' },
	{ code: 'IN', label: 'India' },
	{ code: 'DE', label: 'Germany', also: ['DD'] },
	{ code: 'KR', label: 'South Korea' },
	{ code: 'ES', label: 'Spain' },
	{ code: 'CA', label: 'Canada' },
	{ code: 'HK', label: 'Hong Kong' },
	{ code: 'AU', label: 'Australia' },
	{ code: 'RU', label: 'Russia / USSR', also: ['SU'] },
	{ code: 'MX', label: 'Mexico' },
	{ code: 'CN', label: 'China' },
	{ code: 'PL', label: 'Poland' },
	{ code: 'BR', label: 'Brazil' },
	{ code: 'TR', label: 'Turkey' },
	{ code: 'DK', label: 'Denmark' },
	{ code: 'SE', label: 'Sweden' },
	{ code: 'BE', label: 'Belgium' },
	{ code: 'NO', label: 'Norway' },
	{ code: 'IE', label: 'Ireland' },
	{ code: null, label: 'Elsewhere' },
];

/** "Elsewhere" keeps the neutral — it is the one entry whose meaning really is
 * "not one of the named", so it should not look like a country. */
const COUNTRIES = COUNTRY_LIST.map((c, i) => ({
	...c,
	color: c.code ? CYCLE[i % CYCLE.length] : NEUTRAL,
}));
const COUNTRY_OF = new Map(
	COUNTRIES.flatMap((c, i) => (c.code ? [c.code, ...(c.also ?? [])].map((k) => [k, i]) : [])),
);
const OTHER_COUNTRY = COUNTRIES.findIndex((c) => !c.code);

/** Films in a country before a person counts as having worked there.
 *
 * This is the "absolute" half of the country model: someone belongs to every
 * country they have a real body of work in, not just their most common one.
 * Jackie Chan is Hong Kong by weight (46 films) but has 15 American and 13
 * Chinese ones, so filtering to the United States has to return him. At 3 films
 * about 17% of people belong to more than one country, which is roughly the
 * share whose careers genuinely straddle industries. */
const COUNTRY_MIN_FILMS = 3;

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
function countryProfile(filmIds, filmById) {
	const tally = new Map();
	for (const id of filmIds) {
		const codes = filmById.get(id)?.countries ?? [];
		if (!codes.length) continue;
		const share = 1 / codes.length;
		for (const code of codes) tally.set(code, (tally.get(code) ?? 0) + share);
	}
	if (!tally.size) return { dominant: OTHER_COUNTRY, members: [OTHER_COUNTRY] };

	// Fold codes onto their bucket first, so Russia and the USSR (or Germany and
	// East Germany) are one country rather than competing with each other.
	const byBucket = new Map();
	for (const [code, n] of tally) {
		const b = COUNTRY_OF.get(code) ?? OTHER_COUNTRY;
		byBucket.set(b, (byBucket.get(b) ?? 0) + n);
	}

	let dominant = OTHER_COUNTRY;
	let best = -1;
	const members = [];
	for (const [bucket, n] of byBucket) {
		if (n > best) {
			best = n;
			dominant = bucket;
		}
		if (n >= COUNTRY_MIN_FILMS && bucket !== OTHER_COUNTRY) members.push(bucket);
	}
	// Everyone belongs somewhere, even if no single country clears the floor.
	if (!members.includes(dominant)) members.push(dominant);
	return { dominant, members: members.sort((a, b) => a - b) };
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
		const cp = countryProfile(p.films, filmById);
		p.country = cp.dominant;
		p.countryList = cp.members;
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
			countryList: p.countryList,
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
	// Gravity and the Barnes-Hut angle are pinned rather than inferred, and have to
	// match the values the page re-settles with (see GRAVITY and BARNES_HUT_THETA in
	// src/scripts/credit-network.js) — otherwise pressing Re-settle would visibly
	// respace a layout that had just been shipped at a different density. Gravity is
	// well above the inferred 0.05 because the page fits the layout's bounding box to
	// the canvas, which means a *tighter* periphery is what leaves the core room to
	// spread: on the 1,600-node default view, median nearest-neighbour distance goes
	// from 6.1px at 0.05 to 10.9px at 0.25.
	const settings = {
		...forceAtlas2.inferSettings(graph),
		barnesHutOptimize: true,
		barnesHutTheta: 1.2,
		gravity: 0.25,
		edgeWeightInfluence: 1,
	};
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
				note: 'Career standing, era-adjusted so older figures are not buried by modern vote counts.',
			},
			{ key: 'films', label: 'Films credited', note: 'Raw output, however widely seen.' },
			{
				key: 'hit',
				label: 'Typical hit size',
				note: `Era-adjusted box office per film, so it tracks big films rather than many. ${((withRevenue / films.length) * 100).toFixed(0)}% of films report revenue.`,
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
				note: 'Two substantial roles split the node half-and-half.',
				legend: roles.map((r) => ({ label: r.label, light: r.color, dark: r.color })),
			},
			{
				key: 'country',
				label: 'Where they work',
				field: 'country',
				// Colour by the dominant country, but filter on every country they
				// have a real body of work in — so Jackie Chan paints Hong Kong yet
				// still answers a filter for the United States.
				filterField: 'countryList',
				note: `Coloured by where most of their films were made; filtering matches any country they have ${COUNTRY_MIN_FILMS}+ films in. Only four colours, reused down the list — too many countries for hue to name one, so filter to read a specific country.`,
				legend: COUNTRIES.map((c) => ({ label: c.label, light: c.color, dark: c.color })),
			},
			{
				key: 'era',
				label: 'Era of their career',
				field: 'era',
				note: 'The era containing the median year of their filmography.',
				legend: ERAS.map((e) => ({ label: e.label, light: e.light, dark: e.dark })),
			},
		],
		nodeFields: [
			'tmdbId', 'name', 'x', 'y',
			'films', 'reach', 'hit', 'grossFilms', 'roleMask', 'country', 'countryList', 'era',
			...roles.map((r) => `n_${r.role}`),
		],
		edgeFields: ['source', 'target', 'weight'],
		nodes: ids.map((id) => {
			const a = graph.getNodeAttributes(id);
			return [
				Number(id), a.label, r2(a.x), r2(a.y),
				a.films, a.reach, a.hit, a.grossFilms, a.roleMask, a.country, a.countryList, a.era,
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
