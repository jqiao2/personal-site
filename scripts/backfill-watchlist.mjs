// One-time backfill of a Letterboxd `watchlist.csv` export into the Supabase
// `watchlist` table.
//
// The export has one row per film: `Date` (added), `Name`, `Year`, `Letterboxd
// URI`. Each unique film is resolved to a TMDB id via the search API (results
// cached to scripts/.cache, SHARED with backfill-letterboxd.mjs so overlaps
// aren't re-fetched), its metadata upserted into `movies`, and a `watchlist` row
// inserted with `added_at` = the CSV `Date`.
//
// A watchlist is "films I still want to see", so films already marked watched
// (a row in `watched`) are skipped — matching the app rule that logging a film
// removes it from the watchlist.
//
// Usage (env supplies SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY):
//   node --env-file=.env scripts/backfill-watchlist.mjs [options]
//     --file=<path>       watchlist.csv (default: <dir>/watchlist.csv)
//     --dir=<path>        Letterboxd export folder (or set LETTERBOXD_DIR)
//     --resolve-only      Resolve films to TMDB + build the report; no DB writes
//     --dry-run           Do everything except DB writes
//     --retry-unresolved  Re-attempt TMDB search for films not resolved last run
//     --keep-watched      Don't skip films already in `watched`
//
// Idempotent: movies + watchlist rows are upserted (onConflict), so re-running
// converges on the same state.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache');
const RESOLUTION_CACHE = join(CACHE_DIR, 'resolution.json');
const MOVIES_CACHE = join(CACHE_DIR, 'movies.json');
const REPORT_FILE = join(CACHE_DIR, 'watchlist-report.json');

const args = new Set(process.argv.slice(2));
const getArg = (name) => {
	const hit = [...args].find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
};
const RESOLVE_ONLY = args.has('--resolve-only');
const DRY_RUN = args.has('--dry-run') || RESOLVE_ONLY;
const RETRY_UNRESOLVED = args.has('--retry-unresolved');
const KEEP_WATCHED = args.has('--keep-watched');
const DIR =
	getArg('dir') ||
	process.env.LETTERBOXD_DIR ||
	'C:/Users/jqiao/Downloads/letterboxd-jasonqiao-2026-07-10-15-40-utc';
const FILE = getArg('file') || join(DIR, 'watchlist.csv');

const TMDB_KEY = process.env.TMDB_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CONCURRENCY = 8;
const CHUNK = 500;

// Manual TMDB-id corrections for films the fuzzy search can't get right. Keyed
// by Name||Year. (Shared spirit with backfill-letterboxd.mjs's OVERRIDES.)
const OVERRIDES = new Map([
	['Hamilton||2020', 556574], // filmed musical; TMDB's primary date (2025) trips the year check, and fuzzy search lands on a making-of doc
	['9½ Weeks||1986', 10068], // TMDB titles it "Nine 1/2 Weeks"; the ½ breaks the search match
]);

// Titles the user watchlisted that are TV series (no TMDB *movie*) but whose
// title prefix collides with an unrelated film — force unresolved so we don't
// map them wrong. Most TV resolves to null on its own via the conservative
// matcher below; these are the few that would otherwise get a bad match.
const BLOCKLIST = new Set([
	'Seven Worlds, One Planet||2019',
	'Normal People||2020',
	'Twin Peaks||1989',
	'Twin Peaks: The Return||2017',
	'Sharp Objects||2018',
	'Adolescence||2025',
]);

// --- tiny utils ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filmKey = (name, year) => `${name}||${year}`;
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const deThe = (s) => norm(s).replace(/^the /, '');
const chunk = (arr, n) => {
	const out = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
};
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let i = 0;
	async function worker() {
		while (i < items.length) {
			const idx = i++;
			results[idx] = await fn(items[idx], idx);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
	return results;
}
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, obj) => {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(obj, null, 2));
};

// --- CSV (RFC-4180: quoted fields, embedded commas + newlines, "" escapes) -----
function parseCsv(text) {
	const rows = [];
	let row = [],
		field = '',
		inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else inQuotes = false;
			} else field += c;
		} else if (c === '"') inQuotes = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\r') {
			/* ignore */
		} else if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += c;
	}
	if (field.length || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}
function loadCsv(path) {
	if (!existsSync(path)) return [];
	const rows = parseCsv(readFileSync(path, 'utf8')).filter(
		(r) => r.length > 1 || (r.length === 1 && r[0] !== ''),
	);
	const header = rows[0];
	return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// --- TMDB ---------------------------------------------------------------------
async function tmdbGet(path, params = {}) {
	const url = new URL(`https://api.themoviedb.org/3${path}`);
	url.searchParams.set('api_key', TMDB_KEY);
	for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
	for (let attempt = 0; ; attempt++) {
		let res;
		try {
			res = await fetch(url, { headers: { accept: 'application/json' } });
		} catch (e) {
			if (attempt >= 5) throw e;
			await sleep(2 ** attempt * 500);
			continue;
		}
		if (res.status === 429 || res.status >= 500) {
			if (attempt >= 6) throw new Error(`TMDB ${path} ${res.status}`);
			const ra = Number(res.headers.get('retry-after')) || 2 ** attempt;
			await sleep(ra * 1000);
			continue;
		}
		if (!res.ok) throw new Error(`TMDB ${path} ${res.status}`);
		return res.json();
	}
}

// Conservative best-match: accept only an (ignoring leading "The") exact title or
// a subtitle-extension, within 3 years of the export's. Anything weaker → null so
// TV series and ambiguous titles are left unresolved rather than mis-mapped.
function pickBest(results, name, year) {
	if (!results || !results.length) return null;
	const n = deThe(name);
	const y = year ? Number(year) : null;
	const isPrefix = (t) => t.startsWith(`${n} `);
	let best = null,
		bestScore = -1;
	results.forEach((r, i) => {
		const rt = deThe(r.title),
			ort = deThe(r.original_title);
		const ry = r.release_date ? Number(r.release_date.slice(0, 4)) : null;
		const exact = rt === n || ort === n;
		const prefix = isPrefix(rt) || isPrefix(ort);
		let score = 0;
		if (exact) score += 4;
		else if (prefix) score += 2;
		if (y && ry === y) score += 3;
		else if (y && ry && Math.abs(ry - y) <= 3) score += 1;
		score -= i * 0.02;
		if (score > bestScore) {
			bestScore = score;
			best = { r, ry, exact, prefix };
		}
	});
	const { r, ry, exact, prefix } = best;
	const yearOk = y == null || ry == null || Math.abs(ry - y) <= 3;
	if (!yearOk || (!exact && !prefix)) return null;
	const confidence = exact && ry === y ? 'exact' : exact ? 'title' : 'subtitle';
	return { id: r.id, title: r.title, matchedYear: ry, confidence };
}

async function resolveFilm(key, name, year) {
	if (BLOCKLIST.has(key)) return null;
	if (OVERRIDES.has(key)) return { id: OVERRIDES.get(key), title: null, matchedYear: null, confidence: 'override' };
	let picked = pickBest((await tmdbGet('/search/movie', { query: name, year })).results, name, year);
	if (!picked) picked = pickBest((await tmdbGet('/search/movie', { query: name })).results, name, year);
	return picked;
}

async function tmdbMovieRow(id) {
	const d = await tmdbGet(`/movie/${id}`);
	return {
		tmdb_id: d.id,
		title: d.title,
		release_year: d.release_date ? Number(d.release_date.slice(0, 4)) || null : null,
		poster_path: d.poster_path,
		backdrop_path: d.backdrop_path,
		overview: d.overview || null,
		runtime: d.runtime ?? null,
	};
}

// --- main ---------------------------------------------------------------------
async function main() {
	if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
	if (!DRY_RUN && (!SB_URL || !SB_KEY)) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
	if (!existsSync(FILE)) throw new Error(`watchlist.csv not found: ${FILE}`);
	console.log(`watchlist  : ${FILE}`);
	console.log(`mode       : ${RESOLVE_ONLY ? 'resolve-only' : DRY_RUN ? 'dry-run' : 'WRITE'}\n`);

	const rows = loadCsv(FILE);
	console.log(`csv rows   : ${rows.length}`);

	// Every unique film, keyed by Name+Year. Keep the EARLIEST add date on collisions.
	const films = new Map(); // key -> { name, year, added }
	for (const r of rows) {
		const key = filmKey(r.Name, r.Year);
		const added = isDate(r.Date) ? r.Date : null;
		const cur = films.get(key);
		if (!cur) films.set(key, { name: r.Name, year: r.Year, added });
		else if (added && (!cur.added || added < cur.added)) cur.added = added;
	}
	console.log(`unique films: ${films.size}`);

	// --- Phase 1: resolve each film to a TMDB id (cached, shared with the diary backfill) ---
	const resolution = readJson(RESOLUTION_CACHE, {});
	const toResolve = [...films.entries()].filter(([key]) => {
		const cached = resolution[key];
		if (!cached) return true;
		return RETRY_UNRESOLVED && cached.tmdbId == null;
	});
	console.log(`\nPhase 1 — resolving ${toResolve.length} films to TMDB (${films.size - toResolve.length} cached)`);
	let done = 0;
	await mapLimit(toResolve, CONCURRENCY, async ([key, f]) => {
		try {
			const hit = await resolveFilm(key, f.name, f.year);
			resolution[key] = {
				name: f.name,
				year: f.year,
				tmdbId: hit ? hit.id : null,
				matchedTitle: hit ? hit.title : null,
				matchedYear: hit ? hit.matchedYear : null,
				confidence: hit ? hit.confidence : 'none',
			};
		} catch (e) {
			resolution[key] = { name: f.name, year: f.year, tmdbId: null, confidence: 'error', error: String(e) };
		}
		if (++done % 50 === 0 || done === toResolve.length) {
			process.stdout.write(`\r  resolved ${done}/${toResolve.length}`);
			writeJson(RESOLUTION_CACHE, resolution);
		}
	});
	if (toResolve.length) process.stdout.write('\n');
	writeJson(RESOLUTION_CACHE, resolution);

	const resolvedEntries = [...films.keys()].map((k) => resolution[k]).filter(Boolean);
	const unresolved = resolvedEntries.filter((r) => r.tmdbId == null);
	const byConfidence = resolvedEntries.reduce((a, r) => ((a[r.confidence] = (a[r.confidence] || 0) + 1), a), {});
	console.log(`resolution : ${JSON.stringify(byConfidence)}`);
	console.log(`unresolved : ${unresolved.length}`);

	// --- Phase 2: fetch full TMDB movie rows (cached) ---
	const movieCache = readJson(MOVIES_CACHE, {});
	const tmdbIds = [...new Set(resolvedEntries.filter((r) => r.tmdbId != null).map((r) => r.tmdbId))];
	const missingDetails = tmdbIds.filter((id) => !movieCache[id]);
	console.log(`\nPhase 2 — fetching TMDB details for ${missingDetails.length} movies (${tmdbIds.length - missingDetails.length} cached)`);
	done = 0;
	await mapLimit(missingDetails, CONCURRENCY, async (id) => {
		try {
			movieCache[id] = await tmdbMovieRow(id);
		} catch (e) {
			movieCache[id] = { tmdb_id: id, _error: String(e) };
		}
		if (++done % 50 === 0 || done === missingDetails.length) {
			process.stdout.write(`\r  fetched ${done}/${missingDetails.length}`);
			writeJson(MOVIES_CACHE, movieCache);
		}
	});
	if (missingDetails.length) process.stdout.write('\n');
	writeJson(MOVIES_CACHE, movieCache);

	// --- Report (unresolved + low-confidence to eyeball) ---
	const lowConfidence = resolvedEntries
		.filter((r) => r.tmdbId != null && r.confidence !== 'exact')
		.map((r) => ({ name: r.name, year: r.year, matched: `${r.matchedTitle} (${r.matchedYear})`, confidence: r.confidence }));
	writeJson(REPORT_FILE, {
		generatedFor: FILE,
		counts: { films: films.size, ...byConfidence },
		unresolved: unresolved.map((r) => ({ name: r.name, year: r.year })),
		lowConfidence,
	});
	console.log(`\nreport     : ${REPORT_FILE}`);
	console.log(`  low-confidence matches (non-exact): ${lowConfidence.length}`);
	if (unresolved.length) console.log(`  unresolved: ${unresolved.map((r) => `${r.name} (${r.year})`).join(', ')}`);

	if (RESOLVE_ONLY) {
		console.log('\n--resolve-only: skipping DB writes.');
		return;
	}

	const tmdbIdFor = (key) => resolution[key]?.tmdbId ?? null;

	// --- Phase 3: upsert movies ---
	const sb = DRY_RUN ? null : createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

	const movieRows = tmdbIds
		.map((id) => movieCache[id])
		.filter((m) => m && !m._error)
		.map((m) => ({ ...m, last_synced_at: new Date().toISOString() }));
	console.log(`\nPhase 3 — upserting ${movieRows.length} movies`);
	if (!DRY_RUN) {
		for (const c of chunk(movieRows, CHUNK)) {
			const { error } = await sb.from('movies').upsert(c, { onConflict: 'tmdb_id' });
			if (error) throw new Error(`movies upsert: ${error.message}`);
		}
	}

	// Map tmdb_id -> movies.id (dry-run uses tmdb_id as a stand-in).
	const idMap = new Map();
	if (DRY_RUN) {
		for (const id of tmdbIds) idMap.set(id, id);
	} else {
		for (const c of chunk(tmdbIds, CHUNK)) {
			const { data, error } = await sb.from('movies').select('id, tmdb_id').in('tmdb_id', c);
			if (error) throw new Error(`movies select: ${error.message}`);
			for (const row of data) idMap.set(row.tmdb_id, row.id);
		}
	}

	// Films already watched are dropped from the watchlist (unless --keep-watched).
	const watchedIds = new Set();
	if (!DRY_RUN && !KEEP_WATCHED) {
		const { data, error } = await sb.from('watched').select('movie_id');
		if (error) throw new Error(`watched select: ${error.message}`);
		for (const r of data) watchedIds.add(r.movie_id);
	}

	// --- Phase 4: build + upsert watchlist rows (one per movie, earliest add date) ---
	const watchlistAgg = new Map(); // movie_id -> added (YYYY-MM-DD | null)
	let skippedUnresolved = 0;
	let skippedWatched = 0;
	for (const [key, f] of films) {
		const tmdbId = tmdbIdFor(key);
		const movieId = tmdbId != null ? idMap.get(tmdbId) ?? null : null;
		if (movieId == null) {
			skippedUnresolved++;
			continue;
		}
		if (watchedIds.has(movieId)) {
			skippedWatched++;
			continue;
		}
		const cur = watchlistAgg.get(movieId);
		if (cur === undefined) watchlistAgg.set(movieId, f.added);
		else if (f.added && (!cur || f.added < cur)) watchlistAgg.set(movieId, f.added);
	}

	const watchlistRows = [...watchlistAgg.entries()].map(([movie_id, added]) => ({
		movie_id,
		added_at: `${added || '1970-01-01'}T00:00:00+00:00`,
	}));
	console.log(
		`\nPhase 4 — upserting ${watchlistRows.length} watchlist rows ` +
			`(${skippedUnresolved} skipped: unresolved, ${skippedWatched} skipped: already watched)`,
	);
	if (!DRY_RUN) {
		for (const c of chunk(watchlistRows, CHUNK)) {
			const { error } = await sb.from('watchlist').upsert(c, { onConflict: 'movie_id' });
			if (error) throw new Error(`watchlist upsert: ${error.message}`);
		}
	}

	if (DRY_RUN) {
		console.log(`\n-- dry-run validation --`);
		console.log(`watchlist rows      : ${watchlistRows.length}`);
		console.log(`  with a real date  : ${watchlistRows.filter((r) => !r.added_at.startsWith('1970')).length}`);
		console.log(`earliest added_at   : ${watchlistRows.map((r) => r.added_at).sort()[0] ?? '—'}`);
		console.log(`latest added_at     : ${watchlistRows.map((r) => r.added_at).sort().at(-1) ?? '—'}`);
		console.log(`sample row          : ${JSON.stringify(watchlistRows[0])}`);
	}

	console.log(`\n✓ Watchlist backfill ${DRY_RUN ? '(dry-run) ' : ''}complete.`);
	console.log(`  movies=${movieRows.length} watchlist=${watchlistRows.length}`);
}

main().catch((e) => {
	console.error('\n✗', e.message || e);
	process.exit(1);
});
