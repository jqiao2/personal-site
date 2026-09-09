// Backfill the credit_* tables with the cast/crew of the films Jason has watched
// that the corpus scrape (fetch.mjs, top-15 cast of 50+-vote films) missed:
// films below the vote floor, and cast billed outside the top 15 on films that
// ARE in the corpus. Ensures every watched actor/director is present in
// credit_people with credits on the films they appear in, so the enrichment
// step (build-film-enrichment.mjs) can give them region / era / prominence.
//
// Fetches each watched film's full TMDB credits once, then upserts. Idempotent:
// every write is keyed on its primary key, so re-running converges. Existing
// corpus rows are refreshed, never removed.
//
// Usage (env supplies TMDB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY):
//   node --env-file=.env scripts/credit-graph/backfill-watched.mjs [--dry-run] [--limit=n]

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
const DRY = flag('dry-run');
const LIMIT = args.some((a) => a.startsWith('--limit=')) ? Number.parseInt(opt('limit', '0'), 10) : Infinity;

const TMDB_KEY = process.env.TMDB_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!TMDB_KEY || !SB_URL || !SB_KEY) {
	console.error('Missing env: TMDB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required.');
	process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const TOP_CAST = 15;
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Composer', 'Music']);
const CONCURRENCY = 16;
const REQUEST_TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, task, concurrency) {
	const queue = items.slice();
	const worker = async () => {
		for (;;) {
			const item = queue.shift();
			if (item === undefined) return;
			await task(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function tmdbGet(pathname, params = {}) {
	const url = new URL(`https://api.themoviedb.org/3${pathname}`);
	url.searchParams.set('api_key', TMDB_KEY);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	let lastError;
	for (let attempt = 0; attempt < 6; attempt++) {
		let res;
		try {
			res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		} catch (e) {
			lastError = e;
			await sleep(400 * 2 ** attempt);
			continue;
		}
		if (res.status === 429) {
			const retry = Number.parseInt(res.headers.get('retry-after') || '1', 10);
			await sleep((Number.isFinite(retry) ? retry : 1) * 1000 + 250);
			continue;
		}
		if (res.status === 404) return null;
		if (!res.ok) {
			if (res.status >= 500) { await sleep(400 * 2 ** attempt); continue; }
			throw new Error(`${res.status} ${pathname}`);
		}
		try { return await res.json(); } catch (e) { lastError = e; await sleep(400 * 2 ** attempt); }
	}
	throw new Error(`TMDB ${pathname} failed after retries: ${lastError?.message ?? 'unknown'}`);
}

/** Page past PostgREST's 1000-row cap. */
async function readAll(table, cols, order, filter) {
	const PAGE = 1000, out = [];
	for (let o = 0; ; o += PAGE) {
		let q = sb.from(table).select(cols).order(order, { ascending: true }).range(o, o + PAGE - 1);
		if (filter) q = filter(q);
		const { data, error } = await q;
		if (error) throw new Error(`${table}: ${error.message}`);
		out.push(...(data ?? []));
		if ((data ?? []).length < PAGE) break;
	}
	return out;
}

const BATCH = 2000, PARALLEL = 4;
const TRANSIENT = /fetch failed|network|timeout|ECONN|EAI_AGAIN|socket/i;
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
	console.log('Loading watched films and existing credit_people…');
	const watched = await readAll('watched', 'movies!inner(tmdb_id, actors, directors)', 'movie_id');
	const films = watched.map((w) => w.movies).filter((m) => m?.tmdb_id);
	const unmatched = new Set();
	{
		const people = await readAll('credit_people', 'name', 'tmdb_id');
		const known = new Set(people.map((p) => p.name));
		for (const m of films) for (const n of [...(m.actors ?? []), ...(m.directors ?? [])]) {
			if (n && !known.has(n)) unmatched.add(n);
		}
	}
	console.log(`${films.length.toLocaleString()} watched films; ${unmatched.size} watched people missing from credit_people.`);

	const todo = films.slice(0, LIMIT === Infinity ? undefined : LIMIT);
	const cFilms = new Map(), cPeople = new Map(), cCredits = new Map();
	const add = (filmId, person, role, billing) => {
		const name = (person?.name ?? '').trim();
		if (!person?.id || !name) return;
		cPeople.set(person.id, { tmdb_id: person.id, name });
		cCredits.set(`${filmId}:${person.id}:${role}`, { film_id: filmId, person_id: person.id, role, billing });
	};

	let ok = 0, missing = 0, failed = 0;
	const started = Date.now();
	await pool(todo, async (m) => {
		let d;
		try {
			d = await tmdbGet(`/movie/${m.tmdb_id}`, { append_to_response: 'credits' });
		} catch { failed++; return; }
		if (!d) { missing++; return; }
		const date = /^\d{4}-\d{2}-\d{2}$/.test(d.release_date ?? '') ? d.release_date : null;
		cFilms.set(m.tmdb_id, {
			tmdb_id: m.tmdb_id,
			title: d.title ?? d.original_title ?? `#${m.tmdb_id}`,
			release_year: date ? Number.parseInt(date.slice(0, 4), 10) : null,
			vote_count: d.vote_count ?? 0,
			vote_average: d.vote_average ?? null,
			popularity: d.popularity ?? null,
			revenue: d.revenue ?? 0,
			countries: (d.production_countries ?? []).map((c) => c.iso_3166_1).filter(Boolean),
		});
		const cast = d.credits?.cast ?? [];
		// Corpus convention: top-15 billed cast. Plus any lower-billed cast member
		// who is a watched person still missing from credit_people — the whole
		// point of the backfill.
		cast.forEach((c, i) => {
			if (i < TOP_CAST || unmatched.has((c?.name ?? '').trim())) add(m.tmdb_id, c, 'actor', i);
		});
		for (const c of d.credits?.crew ?? []) {
			if (c.job === 'Director') add(m.tmdb_id, c, 'director', null);
			else if (COMPOSER_JOBS.has(c.job)) add(m.tmdb_id, c, 'composer', null);
		}
		ok++;
		const n = ok + missing + failed;
		if (n % 100 === 0 || n === todo.length) {
			const rate = n / ((Date.now() - started) / 1000);
			process.stdout.write(`\r  fetched ${n}/${todo.length}  ${rate.toFixed(0)}/s  (${missing} gone, ${failed} failed)   `);
		}
	}, CONCURRENCY);
	process.stdout.write('\n');

	const films2 = [...cFilms.values()], people2 = [...cPeople.values()], credits2 = [...cCredits.values()];
	console.log(`Extracted ${films2.length} films, ${people2.length} people, ${credits2.length} credits.`);
	if (DRY) { console.log('Dry run — nothing written.'); return; }

	await upsertAll('credit_films', films2, 'tmdb_id');
	await upsertAll('credit_people', people2, 'tmdb_id');
	await upsertAll('credits', credits2, 'film_id,person_id,role');
	console.log(`Backfilled in ${((Date.now() - started) / 60000).toFixed(1)}m.`);
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
