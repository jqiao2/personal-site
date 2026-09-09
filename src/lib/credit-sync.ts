// Keep the credit-graph tables current as films are logged, so the watched-films
// network (/projects/film-credit-network) reflects a new film the next time it's
// opened -- without an offline rebuild.
//
// syncFilmCredits() runs on the movie-add path (films.ts -> syncMovieFromTmdb),
// reusing the TMDB details already fetched there, so it costs no extra network:
// it records the film's cast/crew into credit_films/credit_people/credits, scores
// the film's era-adjusted percentiles, and re-derives region/era/prominence for
// just that film's people. The full corpus derivation lives in
// scripts/credit-graph/build-film-enrichment.mjs; this is the incremental mirror,
// using the same logic (credit-derive.mjs) and the priors it stored in
// credit-config.json.
//
// Every write is an upsert and the whole thing is wrapped so a failure here can
// never break logging a film -- the graph is worth degrading, the diary is not.
import { supabaseAdmin } from './supabase';
import { releaseYear } from './tmdb';
import type { TmdbMovieDetails } from './tmdb';
import { countryProfile, careerEra, shrunkMean, pctRank, MIN_WINDOW } from './credit-derive.mjs';
import creditConfig from '../data/credit-config.json';

const TOP_CAST = 15;
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Composer', 'Music']);
const round3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** vote_count and (positive) revenue of a film's contemporaries, widening the
 * window past +/-2 years until it holds MIN_WINDOW films, mirroring
 * eraPercentiles in credit-derive.mjs. */
async function windowValues(year: number): Promise<{ votes: number[]; revs: number[] }> {
	for (let span = 2; ; span++) {
		// Page past PostgREST's 1000-row cap: a +/-2-year window in a busy decade
		// holds thousands of films, and a truncated window skews the percentile.
		const rows: { vote_count: number | null; revenue: number | null }[] = [];
		for (let offset = 0; ; offset += 1000) {
			const { data, error } = await supabaseAdmin
				.from('credit_films')
				.select('vote_count, revenue')
				.gte('release_year', year - span)
				.lte('release_year', year + span)
				.order('tmdb_id', { ascending: true })
				.range(offset, offset + 999);
			if (error) throw new Error(`window read failed: ${error.message}`);
			rows.push(...(data ?? []));
			if ((data ?? []).length < 1000) break;
		}
		if (rows.length >= MIN_WINDOW || span > 60) {
			const votes = rows.map((r) => r.vote_count ?? 0).sort((a, b) => a - b);
			const revs = rows.map((r) => r.revenue ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
			return { votes, revs };
		}
	}
}

/** Re-derive region/era/reach/hit for the given people from their full
 * filmography's stored per-film percentiles. `names` supplies the not-null name
 * for anyone being inserted for the first time. */
async function enrichPeople(ids: number[], names: Map<number, string>): Promise<void> {
	if (!ids.length) return;

	// Every credit for these people -> their film ids.
	const filmsByPerson = new Map<number, Set<number>>(ids.map((id) => [id, new Set()]));
	const allFilmIds = new Set<number>();
	for (let i = 0; i < ids.length; i += 300) {
		const { data, error } = await supabaseAdmin
			.from('credits')
			.select('person_id, film_id')
			.in('person_id', ids.slice(i, i + 300));
		if (error) throw new Error(`filmography read failed: ${error.message}`);
		for (const r of data ?? []) {
			filmsByPerson.get(r.person_id)?.add(r.film_id);
			allFilmIds.add(r.film_id);
		}
	}

	// Facts + stored percentiles for every film in those filmographies.
	const factById = new Map<number, { year: number | null; countries: string[]; reach_pct: number | null; gross_pct: number | null }>();
	const filmIdList = [...allFilmIds];
	for (let i = 0; i < filmIdList.length; i += 400) {
		const { data, error } = await supabaseAdmin
			.from('credit_films')
			.select('tmdb_id, release_year, countries, reach_pct, gross_pct')
			.in('tmdb_id', filmIdList.slice(i, i + 400));
		if (error) throw new Error(`film facts read failed: ${error.message}`);
		for (const r of data ?? []) {
			factById.set(r.tmdb_id, { year: r.release_year, countries: r.countries ?? [], reach_pct: r.reach_pct, gross_pct: r.gross_pct });
		}
	}
	const filmForDerive = new Map([...factById].map(([id, f]) => [id, { year: f.year, countries: f.countries }]));

	const now = new Date().toISOString();
	const rows = ids.map((id) => {
		const filmIds = filmsByPerson.get(id) ?? new Set<number>();
		let reachSum = 0, reachN = 0, grossSum = 0, grossN = 0;
		for (const fid of filmIds) {
			const f = factById.get(fid);
			if (f?.reach_pct != null) { reachSum += f.reach_pct; reachN++; }
			if (f?.gross_pct != null) { grossSum += f.gross_pct; grossN++; }
		}
		const cp = countryProfile(filmIds, filmForDerive);
		return {
			tmdb_id: id,
			name: names.get(id) ?? `#${id}`,
			region: cp.dominant,
			region_list: cp.members,
			era: careerEra(filmIds, filmForDerive),
			reach: round2(shrunkMean(reachSum, reachN, creditConfig.reachPrior) * filmIds.size),
			hit: round2(shrunkMean(grossSum, grossN, creditConfig.grossPrior)),
			enriched_at: now,
		};
	});
	const { error } = await supabaseAdmin.from('credit_people').upsert(rows, { onConflict: 'tmdb_id', defaultToNull: false });
	if (error) throw new Error(`enrichment write failed: ${error.message}`);
}

/** Record a just-cached film into the credit graph and enrich its people. A
 * no-op once the film is in the corpus (backfilled or previously synced), so it
 * only does work for films new to the graph. Never throws. */
export async function syncFilmCredits(d: TmdbMovieDetails): Promise<void> {
	try {
		const filmId = d.id;
		const { data: existing } = await supabaseAdmin.from('credit_films').select('tmdb_id').eq('tmdb_id', filmId).maybeSingle();
		if (existing) return; // already in the corpus

		const year = releaseYear(d.release_date);
		const voteCount = d.vote_count ?? 0;
		const revenue = d.revenue ?? 0;
		const countries = (d.production_countries ?? []).map((c) => c.iso_3166_1).filter(Boolean);

		// Score the film against its contemporaries.
		let reachPct: number | null = null;
		let grossPct: number | null = null;
		if (year != null) {
			const { votes, revs } = await windowValues(year);
			reachPct = pctRank(voteCount, votes);
			if (revenue > 0) grossPct = pctRank(revenue, revs);
		}

		const { error: filmErr } = await supabaseAdmin.from('credit_films').upsert(
			{
				tmdb_id: filmId,
				title: d.title ?? `#${filmId}`,
				release_year: year,
				vote_count: voteCount,
				vote_average: d.vote_average ?? null,
				popularity: d.popularity ?? null,
				revenue,
				countries,
				reach_pct: round3(reachPct),
				gross_pct: round3(grossPct),
			},
			{ onConflict: 'tmdb_id', defaultToNull: false },
		);
		if (filmErr) throw new Error(`credit_films write failed: ${filmErr.message}`);

		// Top-billed cast + directors + composers, matching the corpus convention.
		const credits: { id: number; name: string; role: string; billing: number | null }[] = [];
		(d.credits?.cast ?? []).slice(0, TOP_CAST).forEach((c, i) => {
			if (c.id && c.name?.trim()) credits.push({ id: c.id, name: c.name.trim(), role: 'actor', billing: i });
		});
		for (const c of d.credits?.crew ?? []) {
			const role = c.job === 'Director' ? 'director' : COMPOSER_JOBS.has(c.job) ? 'composer' : null;
			if (role && c.id && c.name?.trim()) credits.push({ id: c.id, name: c.name.trim(), role, billing: null });
		}

		const names = new Map<number, string>();
		const people = new Map<number, { tmdb_id: number; name: string }>();
		for (const c of credits) {
			names.set(c.id, c.name);
			people.set(c.id, { tmdb_id: c.id, name: c.name });
		}
		if (people.size) {
			const { error } = await supabaseAdmin.from('credit_people').upsert([...people.values()], { onConflict: 'tmdb_id', defaultToNull: false });
			if (error) throw new Error(`credit_people write failed: ${error.message}`);
		}
		const creditRows = new Map<string, { film_id: number; person_id: number; role: string; billing: number | null }>();
		for (const c of credits) creditRows.set(`${c.id}:${c.role}`, { film_id: filmId, person_id: c.id, role: c.role, billing: c.billing });
		if (creditRows.size) {
			const { error } = await supabaseAdmin.from('credits').upsert([...creditRows.values()], { onConflict: 'film_id,person_id,role', defaultToNull: false });
			if (error) throw new Error(`credits write failed: ${error.message}`);
		}

		await enrichPeople([...people.keys()], names);
	} catch (e) {
		// The film is logged regardless; the graph just misses this one until the
		// next full rebuild.
		console.warn(`syncFilmCredits(${d?.id}) failed: ${(e as Error).message}`);
	}
}
