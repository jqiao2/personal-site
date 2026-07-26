// Stage 1 of the credit-graph pipeline: scrape TMDB into a local NDJSON cache.
//
// This is the slow, network-bound, rate-limited stage, so it is deliberately
// decoupled from the database. It writes an append-only NDJSON file that later
// stages read; re-running skips films already in the cache, so it is safe to
// stop with Ctrl-C and resume. Rebuilding the DB or the graph never re-scrapes.
//
// Two steps:
//   1. Enumerate film ids via /discover/movie above a vote_count floor. TMDB caps
//      discover at page 500 (10k films), so we slice by release year — no single
//      year comes close to the cap — plus one unsliced vote_count sweep to catch
//      films TMDB has no release date for.
//   2. Fetch /movie/{id}?append_to_response=credits for each id and keep only the
//      credits we graph: top-billed cast, directors, composers.
//
// Usage (env supplies TMDB_API_KEY):
//   node --env-file=.env scripts/credit-graph/fetch.mjs [options]
//     --min-votes=<n>  TMDB vote_count floor (default 100, ~23k films)
//     --cast=<n>       Billed cast kept per film (default 15)
//     --limit=<n>      Only fetch n films this run (smoke test)
//     --ids-only       Re-enumerate the id list and stop
//     --force          Ignore the cache and re-fetch everything

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const MIN_VOTES = Number.parseInt(opt('min-votes', '100'), 10);
const TOP_CAST = Number.parseInt(opt('cast', '15'), 10);
const LIMIT = opt('limit') ? Number.parseInt(opt('limit'), 10) : Infinity;
const IDS_ONLY = flag('ids-only');
const FORCE = flag('force');

const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) {
	console.error('Missing env: TMDB_API_KEY. Run with: node --env-file=.env scripts/credit-graph/fetch.mjs');
	process.exit(1);
}

const CACHE_DIR = path.join('scripts', '.cache', 'credit-graph');
const IDS_FILE = path.join(CACHE_DIR, 'film-ids.json');
const FILMS_FILE = path.join(CACHE_DIR, 'films.ndjson');

/** Parallel in-flight TMDB requests. TMDB suggests staying near 50 req/s; 16
 * workers against ~150ms round-trips lands comfortably under that. */
const CONCURRENCY = 16;

/** Earliest release year to enumerate. Nothing before this clears a 100-vote floor. */
const FIRST_YEAR = 1900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-request ceiling. Without this a single stalled socket blocks forever —
 * `fetch` has no default timeout — which silently halts the whole run. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Run `task` over `items` with a fixed-size worker pool, preserving nothing but
 * the side effects. Used for both id enumeration and the per-film credit fetch. */
async function pool(items, task, concurrency) {
	const queue = items.slice();
	async function worker() {
		for (;;) {
			const item = queue.shift();
			if (item === undefined) return;
			await task(item);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** GET a TMDB endpoint. Retries rate limits, timeouts, network blips and 5xx with
 * backoff; a non-404 4xx is permanent, so it fails fast rather than burning the
 * retry budget. Returns parsed JSON, or null for 404. */
async function tmdbGet(pathname, params = {}) {
	const url = new URL(`https://api.themoviedb.org/3${pathname}`);
	url.searchParams.set('api_key', TMDB_KEY);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	let lastError;
	for (let attempt = 0; attempt < 6; attempt++) {
		let res;
		try {
			res = await fetch(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (e) {
			// Timed out, or the connection failed. Both are worth another go.
			lastError = e;
			await sleep(400 * 2 ** attempt);
			continue;
		}
		if (res.status === 429) {
			const retry = Number.parseInt(res.headers.get('retry-after') || '1', 10);
			await sleep((Number.isFinite(retry) ? retry : 1) * 1000 + 250);
			continue;
		}
		// 404 is a real answer: the id was withdrawn from TMDB after enumeration.
		if (res.status === 404) return null;
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			lastError = new Error(`${res.status} ${body.slice(0, 160)}`);
			if (res.status >= 500) {
				await sleep(400 * 2 ** attempt);
				continue;
			}
			throw lastError; // permanent — bad params, revoked key
		}
		try {
			return await res.json();
		} catch (e) {
			lastError = e; // truncated body; retry
			await sleep(400 * 2 ** attempt);
		}
	}
	throw new Error(`TMDB ${pathname} failed after retries: ${lastError?.message ?? 'unknown'}`);
}

/** Parallel in-flight requests during id enumeration. */
const DISCOVER_CONCURRENCY = 12;

/** Build the full id list.
 *
 * TMDB caps /discover at page 500, so the corpus is sliced by release year — no
 * single year comes near 10k films — plus one unsliced vote_count sweep, which
 * catches films TMDB has no release date for and backstops any year-slicing gap.
 *
 * Two phases so the whole thing parallelises: fetch every slice's page 1 to learn
 * its page count, then fetch all remaining pages at once. Sequentially this is
 * ~1,650 round-trips (~14 minutes); pooled it is well under two.
 */
async function enumerateIds() {
	const base = {
		'vote_count.gte': String(MIN_VOTES),
		include_adult: 'false',
		sort_by: 'vote_count.desc',
	};
	const thisYear = new Date().getFullYear();
	const slices = [
		...Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => ({
			...base,
			primary_release_year: String(FIRST_YEAR + i),
		})),
		base, // undated / safety-net sweep
	];

	const ids = new Set();
	const rest = [];

	process.stdout.write(`  probing ${slices.length} slices…`);
	await pool(
		slices,
		async (params) => {
			const first = await tmdbGet('/discover/movie', { ...params, page: '1' });
			if (!first) return;
			for (const m of first.results ?? []) ids.add(m.id);
			const pages = Math.min(first.total_pages ?? 1, 500);
			for (let page = 2; page <= pages; page++) rest.push({ ...params, page: String(page) });
		},
		DISCOVER_CONCURRENCY,
	);

	process.stdout.write(`\r  ${ids.size.toLocaleString()} ids from page 1s; ${rest.length} more pages…      `);
	let fetched = 0;
	await pool(
		rest,
		async (params) => {
			const d = await tmdbGet('/discover/movie', params);
			for (const m of d?.results ?? []) ids.add(m.id);
			if (++fetched % 100 === 0) {
				process.stdout.write(`\r  page ${fetched}/${rest.length} — ${ids.size.toLocaleString()} ids      `);
			}
		},
		DISCOVER_CONCURRENCY,
	);
	process.stdout.write(`\r  ${ids.size.toLocaleString()} ids from ${rest.length + slices.length} pages.          \n`);

	return [...ids];
}

/** TMDB crew job titles that mean "wrote the score". TMDB is inconsistent here —
 * the canonical value is "Original Music Composer" but plenty of films use the
 * shorter two. Deliberately excludes "Songs", "Music Supervisor" and "Music
 * Editor", which are song licensing/editorial rather than composition. */
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Composer', 'Music']);

/** Crew role extractors, keyed by the role name stored in the DB. Adding a future
 * credit type (writer, cinematographer, editor) means adding one line here. */
const CREW_ROLES = {
	director: (c) => c.job === 'Director',
	composer: (c) => COMPOSER_JOBS.has(c.job),
};

/** Reduce a TMDB details+credits payload to the compact cache record: the film's
 * own facts plus a flat credit list of {id, name, role, billing}. Cast is kept in
 * TMDB's billing order and truncated; crew is matched by CREW_ROLES. A person
 * credited twice in the same role on one film is kept once. */
function extractFilm(d, tmdbId) {
	const credits = [];
	const seen = new Set();
	const add = (person, role, billing) => {
		const name = (person?.name ?? '').trim();
		const key = `${person?.id}:${role}`;
		if (!person?.id || !name || seen.has(key)) return;
		seen.add(key);
		credits.push({ id: person.id, name, role, billing });
	};

	for (const [i, c] of (d.credits?.cast ?? []).slice(0, TOP_CAST).entries()) {
		add(c, 'actor', i);
	}
	for (const [role, matches] of Object.entries(CREW_ROLES)) {
		for (const c of d.credits?.crew ?? []) if (matches(c)) add(c, role, null);
	}

	const date = /^\d{4}-\d{2}-\d{2}$/.test(d.release_date ?? '') ? d.release_date : null;
	return {
		id: tmdbId,
		title: d.title ?? d.original_title ?? `#${tmdbId}`,
		year: date ? Number.parseInt(date.slice(0, 4), 10) : null,
		vote_count: d.vote_count ?? 0,
		vote_average: d.vote_average ?? 0,
		popularity: d.popularity ?? 0,
		credits,
	};
}

/** Film ids already present in the NDJSON cache, so a resumed run skips them.
 * Tolerates a truncated final line from an interrupted run. */
async function cachedIds() {
	const done = new Set();
	try {
		const rl = createInterface({
			input: createReadStream(FILMS_FILE),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				done.add(JSON.parse(line).id);
			} catch {
				// Partial write from an interrupted run; the id gets re-fetched.
			}
		}
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	return done;
}

async function main() {
	await mkdir(CACHE_DIR, { recursive: true });

	// Step 1: the id list. Cached separately — enumeration is ~1.2k requests and
	// rarely needs redoing, so only --ids-only or a missing file rebuilds it.
	let ids;
	if (!IDS_ONLY) {
		try {
			const saved = JSON.parse(await readFile(IDS_FILE, 'utf8'));
			if (saved.minVotes === MIN_VOTES) {
				ids = saved.ids;
				console.log(`Reusing cached id list: ${ids.length.toLocaleString()} films (votes >= ${MIN_VOTES}).`);
			}
		} catch {
			// No cached list yet, or it was written for a different floor.
		}
	}
	if (!ids) {
		console.log(`Enumerating films with vote_count >= ${MIN_VOTES}…`);
		ids = await enumerateIds();
		await writeFile(IDS_FILE, JSON.stringify({ minVotes: MIN_VOTES, ids }));
		console.log(`Enumerated ${ids.length.toLocaleString()} films -> ${IDS_FILE}`);
	}
	if (IDS_ONLY) return;

	// Step 2: credits per film, appended as we go so progress survives a Ctrl-C.
	const done = FORCE ? new Set() : await cachedIds();
	const todo = ids.filter((id) => !done.has(id)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
	console.log(
		`${done.size.toLocaleString()} already cached; fetching credits for ${todo.length.toLocaleString()} films ` +
			`(top ${TOP_CAST} cast + directors + composers).`,
	);
	if (todo.length === 0) {
		console.log('Nothing to fetch — cache is complete.');
		return;
	}

	const out = createWriteStream(FILMS_FILE, { flags: FORCE ? 'w' : 'a' });
	/** Backpressure-aware append: a 23k-film run outruns the disk otherwise. */
	const write = (line) =>
		out.write(line) ? Promise.resolve() : new Promise((r) => out.once('drain', r));

	let ok = 0;
	let missing = 0;
	let failed = 0;
	const failures = [];
	const started = Date.now();

	await pool(
		todo,
		async (id) => {
			try {
				const d = await tmdbGet(`/movie/${id}`, { append_to_response: 'credits' });
				if (d === null) {
					missing++;
				} else {
					await write(`${JSON.stringify(extractFilm(d, id))}\n`);
					ok++;
				}
			} catch (e) {
				failed++;
				if (failures.length < 40) failures.push(`${id}: ${e.message}`);
			}
			const n = ok + missing + failed;
			if (n % 100 === 0 || n === todo.length) {
				const rate = n / ((Date.now() - started) / 1000);
				const eta = Math.round((todo.length - n) / Math.max(rate, 0.1));
				process.stdout.write(
					`\r  ${n.toLocaleString()}/${todo.length.toLocaleString()}  ` +
						`${rate.toFixed(0)}/s  eta ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s  ` +
						`(${missing} gone, ${failed} failed)    `,
				);
			}
		},
		CONCURRENCY,
	);
	await new Promise((r) => out.end(r));
	process.stdout.write('\n');

	const mins = ((Date.now() - started) / 60000).toFixed(1);
	console.log(`Done in ${mins}m. Cached ${ok.toLocaleString()} films, ${missing} withdrawn, ${failed} failed.`);
	if (failures.length) {
		console.log('First failures:');
		for (const f of failures) console.log(`  ${f}`);
		console.log('Re-run to retry them (the cache is resumable).');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
