// Credit collaboration network (from watched films).
// Split out of films.ts to cut read-cost (wiki 0021): the only consumer is
// /projects/film-credit-network. Shares the watched-facts aggregate loader with
// the stats page, so it imports loadWatchedFacts/yearOf/YearOption from films.ts.
import creditConfig from '../data/credit-config.json';
import { supabasePublic } from './supabase';
import { loadWatchedFacts, yearOf, type YearOption } from './films';

/** The graph payload the /projects/film-credit-network client renders, in the
 * same positional-array schema as scripts/credit-graph/build.mjs so the shared
 * renderer (src/scripts/credit-network.js) reads it unchanged. Built live from
 * the films you've watched, scoped to one calendar year, and joined to the
 * credit_* tables for exact TMDB person ids, composer credits, and career-wide
 * region / era / prominence. The credit tables are kept current on the movie-add
 * path (src/lib/credit-sync.ts), so a newly-logged film is reflected the next
 * time this page is opened. */
export interface FilmCreditNetwork {
	scope: number | 'all';
	selectedLabel: string;
	yearOptions: YearOption[];
	/** The renderer payload; null when the scope has too few connected people. */
	graph: Record<string, unknown> | null;
}

const NET_ROLE_SHARE_FLOOR = creditConfig.roleShareFloor;

const NET_MIN_EDGE = 1;

/** role name -> slice index, from the frozen config order (actor/director/composer). */
const ROLE_IDX: Record<string, number> = Object.fromEntries(creditConfig.roles.map((r, i) => [r.role, i]));

const REGION_MODE = creditConfig.colorModes.find((m) => m.key === 'country');

const ERA_MODE = creditConfig.colorModes.find((m) => m.key === 'era');

/** Fallback buckets for a person with no stored enrichment (a film not yet in
 * the credit tables): "Elsewhere" and the latest era. */
const OTHER_REGION = (REGION_MODE?.legend.length ?? 1) - 1;

const LAST_ERA = (ERA_MODE?.legend.length ?? 1) - 1;

/** credits for a set of films: film tmdb_id -> [[person_id, roleIdx], ...]. */
async function creditsForFilms(tmdbIds: number[]): Promise<Map<number, [number, number][]>> {
	const byFilm = new Map<number, [number, number][]>();

	for (let i = 0; i < tmdbIds.length; i += 300) {
		const chunk = tmdbIds.slice(i, i + 300);

		// Page past PostgREST's 1000-row cap: 300 films carry several thousand
		// credit rows, and a truncated page drops whole films — which then fall
		// through to the name-based fallback and duplicate people into a second,
		// id-less network (wiki 0017).
		for (let offset = 0; ; offset += 1000) {
			const { data, error } = await supabasePublic
				.from('credits')
				.select('film_id, person_id, role')
				.in('film_id', chunk)
				.order('film_id', { ascending: true })
				.order('person_id', { ascending: true })
				.range(offset, offset + 999);

			if (error) throw new Error(`credits read failed: ${error.message}`);

			for (const r of data ?? []) {
				const ri = ROLE_IDX[r.role as string];

				if (ri === undefined) continue;
				const arr = byFilm.get(r.film_id);

				if (arr) arr.push([r.person_id, ri]);
				else byFilm.set(r.film_id, [[r.person_id, ri]]);
			}

			if ((data ?? []).length < 1000) break;
		}
	}

	return byFilm;
}

interface PersonEnrichment {
	name: string;
	region: number;
	regionList: number[];
	era: number;
	reach: number;
	hit: number;
}

/** Stored enrichment + name for a set of people (the surviving nodes). */
async function enrichmentFor(ids: number[]): Promise<Map<number, PersonEnrichment>> {
	const out = new Map<number, PersonEnrichment>();

	for (let i = 0; i < ids.length; i += 400) {
		const { data, error } = await supabasePublic
			.from('credit_people')
			.select('tmdb_id, name, region, region_list, era, reach, hit')
			.in('tmdb_id', ids.slice(i, i + 400));

		if (error) throw new Error(`credit_people read failed: ${error.message}`);

		for (const r of data ?? []) {
			out.set(r.tmdb_id, {
				name: r.name,
				region: r.region ?? OTHER_REGION,
				regionList: r.region_list ?? [OTHER_REGION],
				era: r.era ?? LAST_ERA,
				reach: r.reach ?? 0,
				hit: r.hit ?? 0,
			});
		}
	}

	return out;
}

export async function getFilmCreditNetwork(scope: number | 'all' = 'all'): Promise<FilmCreditNetwork> {
	const all = await loadWatchedFacts();

	// Year picker, identical to getFilmStats so the two pages agree on scopes.
	const perYear = new Map<number, number>();

	for (const r of all) {
		const y = yearOf(r.first_watched);

		if (y != null) perYear.set(y, (perYear.get(y) ?? 0) + 1);
	}

	const eligibleYears = [...perYear.entries()]
		.filter(([, c]) => c > 10)
		.map(([y]) => y)
		.sort((a, b) => b - a);

	const yearOptions: YearOption[] = [
		{ key: 'all', label: 'All time', count: '' },
		...eligibleYears.map((y) => ({ key: y, label: String(y), count: `${perYear.get(y)} films` })),
	];

	const isAll = scope === 'all' || !eligibleYears.includes(scope as number);
	const selected: number | 'all' = isAll ? 'all' : (scope as number);
	const rows = isAll ? all : all.filter((r) => yearOf(r.first_watched) === selected);
	const selectedLabel = isAll ? 'All time' : String(selected);
	const empty: FilmCreditNetwork = { scope: selected, selectedLabel, yearOptions, graph: null };

	// All-time spans ~1,000 films, so require someone in 2+ of them to keep the
	// graph to real recurrences. A single year is ~35 films where almost nobody
	// repeats, so anyone in a film qualifies and the structure comes from each
	// film's shared cast. Isolates (nobody to share with) are dropped either way.
	const minRole = isAll ? 2 : 1;

	const watchedTmdb = [...new Set(rows.map((r) => r.tmdb_id).filter((x): x is number => x != null))];
	const byFilm = await creditsForFilms(watchedTmdb);

	// 1. Tally each person over films in scope. Key by TMDB person id when the film
	//    is in the credit tables (exact -- disambiguates same-named people and adds
	//    composers); otherwise fall back to the movies-table names, which cover
	//    actors and directors only and carry no enrichment.
	type P = { name: string; id: number | null; counts: number[]; films: Set<number>; ratingSum: number; rated: number };

	const roleCount = creditConfig.roles.length;
	const people = new Map<string, P>();
	const filmKeys: string[][] = [];
	rows.forEach((r, fi) => {
		const onFilm = new Set<string>();

		const bump = (key: string, name: string, id: number | null, ri: number) => {
			let p = people.get(key);

			if (!p) {
				p = { name, id, counts: new Array(roleCount).fill(0), films: new Set(), ratingSum: 0, rated: 0 };
				people.set(key, p);
			}

			p.counts[ri]++;

			if (!onFilm.has(key)) {
				onFilm.add(key);
				p.films.add(fi);

				if (r.rating != null) {
					p.ratingSum += r.rating;
					p.rated++;
				}
			}
		};

		const credits = r.tmdb_id != null ? byFilm.get(r.tmdb_id) : undefined;

		if (credits) {
			for (const [pid, ri] of credits) bump(`id:${pid}`, `#${pid}`, pid, ri);
		} else {
			for (const n of r.actors) if (n) bump(`nm:${n}`, n, null, 0);

			for (const n of r.directors) if (n) bump(`nm:${n}`, n, null, 1);
		}

		filmKeys.push([...onFilm]);
	});

	// 2. Qualify + which roles are drawn (share floor).
	type Q = P & { qmask: number };

	const qualified = new Map<string, Q>();

	for (const [key, p] of people) {
		const cleared = p.counts.flatMap((c, i) => (c >= minRole ? [i] : []));

		if (!cleared.length) continue;
		const total = p.counts.reduce((a, b) => a + b, 0);
		const major = cleared.filter((i) => p.counts[i] / total >= NET_ROLE_SHARE_FLOOR);

		const drawn = major.length
			? major
			: [cleared.reduce((best, i) => (p.counts[i] > p.counts[best] ? i : best), cleared[0])];

		qualified.set(key, { ...p, qmask: drawn.reduce((m, i) => m | (1 << i), 0) });
	}

	// 3. Co-credit edges from each film's qualified people.
	const edgeW = new Map<string, number>();

	for (const keys of filmKeys) {
		const on = keys.filter((k) => qualified.has(k)).sort();

		for (let i = 0; i < on.length; i++) {
			for (let j = i + 1; j < on.length; j++) {
				const e = `${on[i]}\t${on[j]}`;
				edgeW.set(e, (edgeW.get(e) ?? 0) + 1);
			}
		}
	}

	// 4. Keep people with a surviving edge.
	const connected = new Set<string>();
	const edges: [string, string, number][] = [];

	for (const [k, w] of edgeW) {
		if (w < NET_MIN_EDGE) continue;
		const [a, b] = k.split('\t');
		edges.push([a, b, w]);
		connected.add(a);
		connected.add(b);
	}

	const keys = [...connected];

	if (keys.length < 2) return empty;
	const idx = new Map(keys.map((k, i) => [k, i]));

	// 5. Enrichment + names for just the surviving id-keyed nodes.
	const nodeIds = keys.filter((k) => k.startsWith('id:')).map((k) => Number(k.slice(3)));
	const enr = await enrichmentFor(nodeIds);

	// 6. Seed positions on a circle; the client's ForceAtlas2 settles from there.
	const r2 = (v: number) => Math.round(v * 100) / 100;

	const nodes = keys.map((key, i) => {
		const p = qualified.get(key)!;
		const e = p.id != null ? enr.get(p.id) : undefined;
		const a = (2 * Math.PI * i) / keys.length;
		const rating = p.rated ? r2(p.ratingSum / p.rated) : 0;

		return [
			e?.name ?? p.name,
			r2(Math.cos(a) * 1000),
			r2(Math.sin(a) * 1000),
			p.films.size,
			rating,
			e ? e.reach : 0,
			e ? e.hit : 0,
			p.qmask,
			e ? e.region : OTHER_REGION,
			e ? e.regionList : [OTHER_REGION],
			e ? e.era : LAST_ERA,
			p.counts[0],
			p.counts[1],
			p.counts[2] ?? 0,
		];
	});

	const graph = {
		meta: {
			generated: new Date().toISOString(),
			films: rows.length,
			people: people.size,
			nodes: keys.length,
			edges: edges.length,
			minEdge: NET_MIN_EDGE,
			// All-time is dense enough that one shared film whites out the core, so
			// start it on recurring collaborations (2+); a single year is sparse, so
			// start at the floor. The slider still reaches down to minEdge.
			defaultMinWeight: isAll ? 2 : NET_MIN_EDGE,
			forceTheme: 'dark',
			settleOnLoad: true,
			personHref: '/films/watched?{role}={name}',
			personLabel: 'See these in your log ↗',
		},
		roles: creditConfig.roles.map((r) => ({ role: r.role, label: r.label, color: r.color, minFilms: minRole })),
		metrics: [
			{ key: 'films', label: 'Films in your log', note: 'How many of your watched films they appear in.' },
			{ key: 'rating', label: 'Your average rating', note: 'Mean of your ratings across their films; unrated counts as 0.' },
			{ key: 'reach', label: 'Prominence', note: 'Career standing across all their films, era-adjusted so older figures are not buried by modern vote counts.' },
			{ key: 'hit', label: 'Typical hit size', note: 'Era-adjusted box office per film across their whole career -- big films rather than many.' },
		],
		roleShareFloor: NET_ROLE_SHARE_FLOOR,
		colorModes: creditConfig.colorModes,
		nodeFields: [
			'name', 'x', 'y', 'films', 'rating', 'reach', 'hit', 'roleMask',
			'country', 'countryList', 'era', 'n_actor', 'n_director', 'n_composer',
		],
		edgeFields: ['source', 'target', 'weight'],
		nodes,
		edges: edges.map(([a, b, w]) => [idx.get(a), idx.get(b), w]),
	};

	return { scope: selected, selectedLabel, yearOptions, graph };
}
