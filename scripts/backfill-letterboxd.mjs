// One-time backfill of a Letterboxd CSV export into the Supabase film DB.
//
// Maps the export onto our schema:
//   watched.csv  -> `watched`  (one row per film: first_watched, rating, liked, tmdb_url)
//   ratings.csv  -> watched.rating   (film-level rating; joined by Name+Year)
//   likes/films  -> watched.liked    (film-level like;   joined by Name+Year)
//   diary.csv    -> `logs`     (one row per viewing: watched_date, log date, rating,
//                               rewatched, liked, tags)
//   reviews.csv  -> logs.review_text (joined to its diary entry by the per-entry URI)
//
// Note: diary/reviews rows carry a *per-entry* Letterboxd URI, while
// watched/ratings/likes carry a *per-film* URI — so the only reliable cross-file
// key is Name+Year. Each unique film is resolved to a TMDB id via the search API
// (results cached to scripts/.cache so re-runs don't re-hit TMDB).
//
// Usage (env supplies SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY):
//   node --env-file=.env scripts/backfill-letterboxd.mjs [options]
//     --dir=<path>        Letterboxd export folder (or set LETTERBOXD_DIR)
//     --resolve-only      Resolve films to TMDB + build the report; no DB writes
//     --dry-run           Do everything except DB writes
//     --retry-unresolved  Re-attempt TMDB search for films not resolved last run
//
// Idempotent: movies/watched are upserted; logs are wiped and re-inserted.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache');
const RESOLUTION_CACHE = join(CACHE_DIR, 'resolution.json');
const MOVIES_CACHE = join(CACHE_DIR, 'movies.json');
const REPORT_FILE = join(CACHE_DIR, 'backfill-report.json');

const args = new Set(process.argv.slice(2));
const getArg = (name) => {
	const hit = [...args].find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
};
const RESOLVE_ONLY = args.has('--resolve-only');
const DRY_RUN = args.has('--dry-run') || RESOLVE_ONLY;
const RETRY_UNRESOLVED = args.has('--retry-unresolved');
const DIR =
	getArg('dir') ||
	process.env.LETTERBOXD_DIR ||
	'C:/Users/jqiao/Downloads/letterboxd-jasonqiao-2026-07-10-15-40-utc';

const TMDB_KEY = process.env.TMDB_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CONCURRENCY = 8;
const CHUNK = 500;

// Manual TMDB-id corrections for real films the fuzzy search can't get right
// (alternate titles / same-year sequels). Keyed by Name||Year.
const OVERRIDES = new Map([
	['Drunken Master II||1994', 12207], // TMDB titles it "The Legend of Drunken Master"
	['I Spit on Your Grave||1978', 25239], // released as "Day of the Woman"
	['$||1971', 31644], // "$" (Dollars) — search can't match a bare "$"
]);

// TV series logged on Letterboxd that have no TMDB *movie*, but whose title
// prefix collides with an unrelated movie/making-of. Force them unresolved so we
// don't map them to the wrong film. (Most TV resolves to null on its own; these
// are the few that would otherwise get a bad match.)
const BLOCKLIST = new Set([
	'Planet Earth II||2016',
	'Planet Earth||2006',
	'Chernobyl||2019',
	'Squid Game||2021',
	'Our Planet||2019',
	'Cosmos||2014',
	'Evil Genius||2018',
	'The Hunt||2015', // TV show; would otherwise mis-match the 2012 film
]);

// --- tiny utils ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filmKey = (name, year) => `${name}||${year}`;
const norm = (s) =>
	(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const deThe = (s) => norm(s).replace(/^the /, ''); // ignore a leading "The" when comparing titles
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
function loadCsv(name) {
	const path = join(DIR, name);
	if (!existsSync(path)) return [];
	const rows = parseCsv(readFileSync(path, 'utf8')).filter(
		(r) => r.length > 1 || (r.length === 1 && r[0] !== ''),
	);
	const header = rows[0];
	return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function parseRating(s) {
	if (!s) return null;
	const n = Number(s);
	if (!Number.isFinite(n) || n < 0.5 || n > 5 || !Number.isInteger(n * 2)) return null;
	return n;
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

// Pick the best search hit for a Name+Year. Deliberately CONSERVATIVE: only
// accept a match whose title equals the query (ignoring a leading "The") or is a
// subtitle-extension of it ("Glass Onion" → "Glass Onion: A Knives Out Mystery"),
// and whose year is within 3 of the export's. Anything weaker returns null so the
// film is left unresolved rather than mapped to an unrelated movie — most weak
// hits are TV series (Loki, Chernobyl, Planet Earth) that aren't TMDB movies.
function pickBest(results, name, year) {
	if (!results || !results.length) return null;
	const n = deThe(name);
	const y = year ? Number(year) : null;
	const isPrefix = (t) => t.startsWith(`${n} `); // word-boundary prefix (subtitle)
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
		score -= i * 0.02; // popularity tiebreak (results are popularity-ordered)
		if (score > bestScore) {
			bestScore = score;
			best = { r, ry, exact, prefix };
		}
	});
	const { r, ry, exact, prefix } = best;
	const yearOk = y == null || ry == null || Math.abs(ry - y) <= 3;
	if (!yearOk || (!exact && !prefix)) return null; // untrustworthy → leave unresolved
	const confidence = exact && ry === y ? 'exact' : exact ? 'title' : 'subtitle';
	return { id: r.id, title: r.title, matchedYear: ry, confidence };
}

async function resolveFilm(key, name, year) {
	if (BLOCKLIST.has(key)) return null; // known TV series → leave unresolved
	if (OVERRIDES.has(key)) return { id: OVERRIDES.get(key), title: null, matchedYear: null, confidence: 'override' };
	let picked = pickBest((await tmdbGet('/search/movie', { query: name, year })).results, name, year);
	if (!picked) picked = pickBest((await tmdbGet('/search/movie', { query: name })).results, name, year);
	return picked; // {id,title,matchedYear,confidence} | null
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
	if (!existsSync(DIR)) throw new Error(`Letterboxd export dir not found: ${DIR}`);
	console.log(`export dir : ${DIR}`);
	console.log(`mode       : ${RESOLVE_ONLY ? 'resolve-only' : DRY_RUN ? 'dry-run' : 'WRITE'}\n`);

	const diary = loadCsv('diary.csv');
	const watched = loadCsv('watched.csv');
	const ratings = loadCsv('ratings.csv');
	const reviews = loadCsv('reviews.csv');
	const likes = loadCsv('likes/films.csv');
	console.log(
		`csv rows   : diary=${diary.length} watched=${watched.length} ratings=${ratings.length} ` +
			`reviews=${reviews.length} likes=${likes.length}`,
	);

	// Lookup maps keyed by film identity (Name+Year).
	const ratingByFilm = new Map(ratings.map((r) => [filmKey(r.Name, r.Year), parseRating(r.Rating)]));
	const likedFilms = new Set(likes.map((r) => filmKey(r.Name, r.Year)));
	const reviewByUri = new Map(reviews.map((r) => [r['Letterboxd URI'], (r.Review || '').trim()]));

	// Every unique film across the export (watched is the superset; diary ⊆ watched).
	const films = new Map(); // key -> { name, year, tmdbUrl }
	for (const r of watched)
		films.set(filmKey(r.Name, r.Year), { name: r.Name, year: r.Year, tmdbUrl: r['Letterboxd URI'] });
	for (const r of diary)
		if (!films.has(filmKey(r.Name, r.Year)))
			films.set(filmKey(r.Name, r.Year), { name: r.Name, year: r.Year, tmdbUrl: null });
	console.log(`unique films: ${films.size}`);

	// --- Phase 1: resolve each film to a TMDB id (cached) ---
	const resolution = readJson(RESOLUTION_CACHE, {}); // key -> {name,year,tmdbId,matchedTitle,matchedYear,confidence}
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
			writeJson(RESOLUTION_CACHE, resolution); // checkpoint
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
	const movieCache = readJson(MOVIES_CACHE, {}); // tmdbId -> movie row
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

	// --- Build report (low-confidence matches to eyeball) ---
	const lowConfidence = resolvedEntries
		.filter((r) => r.tmdbId != null && r.confidence !== 'exact')
		.map((r) => ({ name: r.name, year: r.year, matched: `${r.matchedTitle} (${r.matchedYear})`, confidence: r.confidence }));
	writeJson(REPORT_FILE, {
		generatedFor: DIR,
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

	// tmdbId helper for a film key
	const tmdbIdFor = (key) => resolution[key]?.tmdbId ?? null;

	// --- Phase 3: write movies ---
	const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

	// Preflight: watched.rating/liked must exist (migration 0003).
	const { error: colErr } = DRY_RUN ? {} : await sb.from('watched').select('rating, liked').limit(1);
	if (colErr) {
		console.error(
			`\n✗ watched.rating/liked columns are missing — apply migration 0003 first:\n` +
				`    supabase/migrations/0003_watched_rating_liked.sql\n` +
				`  (paste it in the Supabase SQL editor, or link the CLI and run \`npx supabase db push\`).\n` +
				`  Then re-run this script.`,
		);
		process.exit(1);
	}

	const movieRows = tmdbIds.map((id) => movieCache[id]).filter((m) => m && !m._error).map((m) => ({
		...m,
		last_synced_at: new Date().toISOString(),
	}));
	console.log(`\nPhase 3 — upserting ${movieRows.length} movies`);
	if (!DRY_RUN) {
		for (const c of chunk(movieRows, CHUNK)) {
			const { error } = await sb.from('movies').upsert(c, { onConflict: 'tmdb_id' });
			if (error) throw new Error(`movies upsert: ${error.message}`);
		}
	}

	// Map tmdb_id -> movies.id (dry-run has no DB rows, so use tmdb_id as a stand-in).
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
	const movieIdFor = (key) => {
		const t = tmdbIdFor(key);
		return t != null ? idMap.get(t) ?? null : null;
	};

	// --- Phase 4: watched (one row per movie) ---
	// first_watched = earliest known date: the watched.csv add-date and any diary
	// viewing date for that film. Aggregate per movie_id (dedupe collisions).
	const watchedAgg = new Map(); // movie_id -> { first, rating, liked, tmdb_url }
	const addWatched = (key, dateCandidates, tmdbUrl) => {
		const mid = movieIdFor(key);
		if (mid == null) return;
		const dates = dateCandidates.filter(isDate).sort();
		const first = dates[0] || null;
		const cur = watchedAgg.get(mid) || { first: null, rating: null, liked: false, tmdb_url: null };
		if (first && (!cur.first || first < cur.first)) cur.first = first;
		const rating = ratingByFilm.get(key);
		if (rating != null) cur.rating = rating;
		if (likedFilms.has(key)) cur.liked = true;
		if (tmdbUrl && !cur.tmdb_url) cur.tmdb_url = tmdbUrl;
		watchedAgg.set(mid, cur);
	};
	// diary viewing dates per film
	const diaryDatesByFilm = new Map();
	for (const r of diary) {
		const k = filmKey(r.Name, r.Year);
		if (!diaryDatesByFilm.has(k)) diaryDatesByFilm.set(k, []);
		if (isDate(r['Watched Date'])) diaryDatesByFilm.get(k).push(r['Watched Date']);
	}
	for (const r of watched) {
		const k = filmKey(r.Name, r.Year);
		addWatched(k, [r.Date, ...(diaryDatesByFilm.get(k) || [])], r['Letterboxd URI']);
	}
	// diary-only films (not in watched.csv) still need a watched row
	for (const [k, dates] of diaryDatesByFilm) if (!films.get(k)?.tmdbUrl) addWatched(k, dates, null);

	const watchedRows = [...watchedAgg.entries()].map(([movie_id, w]) => ({
		movie_id,
		first_watched: `${w.first || '1970-01-01'}T00:00:00+00:00`,
		rating: w.rating,
		liked: w.liked,
		tmdb_url: w.tmdb_url,
	}));
	console.log(`Phase 4 — upserting ${watchedRows.length} watched rows`);
	if (!DRY_RUN) {
		for (const c of chunk(watchedRows, CHUNK)) {
			const { error } = await sb.from('watched').upsert(c, { onConflict: 'movie_id' });
			if (error) throw new Error(`watched upsert: ${error.message}`);
		}
	}

	// --- Phase 5: logs (one per diary entry) + tags ---
	const logInputs = []; // { row, movie_id, tags[] }
	let skippedLogs = 0;
	for (const r of diary) {
		const key = filmKey(r.Name, r.Year);
		const mid = movieIdFor(key);
		if (mid == null) {
			skippedLogs++;
			continue;
		}
		const tags = (r.Tags || '')
			.split(',')
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean);
		logInputs.push({
			movie_id: mid,
			watched_date: isDate(r['Watched Date']) ? r['Watched Date'] : null,
			log: isDate(r.Date) ? r.Date : null,
			rating: parseRating(r.Rating),
			review_text: reviewByUri.get(r['Letterboxd URI']) || null,
			rewatched: r.Rewatch === 'Yes',
			liked: likedFilms.has(key),
			tags: [...new Set(tags)],
		});
	}
	console.log(`Phase 5 — inserting ${logInputs.length} logs (${skippedLogs} skipped: unresolved film)`);

	if (!DRY_RUN) {
		// Idempotent: clear existing logs (log_tags cascade) before re-inserting.
		const { error: delErr } = await sb.from('logs').delete().gte('id', 0);
		if (delErr) throw new Error(`logs delete: ${delErr.message}`);

		// Insert logs chunk-by-chunk; bulk insert returns rows in input order, so we
		// align returned ids back to their source rows to attach tags.
		const withTags = []; // { logId, tags[] }
		for (const c of chunk(logInputs, CHUNK)) {
			const payload = c.map(({ tags, ...row }) => row);
			const { data, error } = await sb.from('logs').insert(payload).select('id');
			if (error) throw new Error(`logs insert: ${error.message}`);
			data.forEach((row, i) => {
				if (c[i].tags.length) withTags.push({ logId: row.id, tags: c[i].tags });
			});
		}

		// Upsert the tag dictionary, then link.
		const tagNames = [...new Set(withTags.flatMap((w) => w.tags))];
		const tagId = new Map();
		if (tagNames.length) {
			for (const c of chunk(tagNames, CHUNK)) {
				const { data, error } = await sb
					.from('tags')
					.upsert(c.map((name) => ({ name })), { onConflict: 'name' })
					.select('id, name');
				if (error) throw new Error(`tags upsert: ${error.message}`);
				for (const t of data) tagId.set(t.name, t.id);
			}
			const links = withTags.flatMap((w) => w.tags.map((t) => ({ log_id: w.logId, tag_id: tagId.get(t) })));
			for (const c of chunk(links, CHUNK)) {
				const { error } = await sb.from('log_tags').insert(c);
				if (error) throw new Error(`log_tags insert: ${error.message}`);
			}
			console.log(`  tags: ${tagNames.length} distinct, ${links.length} links`);
		}
	}

	if (DRY_RUN) {
		const w = watchedRows;
		const l = logInputs;
		console.log(`\n-- dry-run validation --`);
		console.log(`watched: ${w.length} rows | with rating=${w.filter((r) => r.rating != null).length} | liked=${w.filter((r) => r.liked).length} | with tmdb_url=${w.filter((r) => r.tmdb_url).length}`);
		console.log(`logs:    ${l.length} rows | with review=${l.filter((r) => r.review_text).length} | with rating=${l.filter((r) => r.rating != null).length} | rewatched=${l.filter((r) => r.rewatched).length} | liked=${l.filter((r) => r.liked).length} | with tags=${l.filter((r) => r.tags.length).length}`);
		const sampleReview = l.find((r) => r.review_text && r.tags.length);
		const sampleRewatch = l.find((r) => r.rewatched);
		console.log(`sample log (review+tags):`, JSON.stringify({ ...sampleReview, review_text: sampleReview?.review_text?.slice(0, 50) + '…' }));
		console.log(`sample log (rewatch)    :`, JSON.stringify(sampleRewatch));
		console.log(`sample watched (rating) :`, JSON.stringify(w.find((r) => r.rating != null)));
		console.log(`earliest first_watched  :`, w.map((r) => r.first_watched).sort()[0]);
	}

	console.log(`\n✓ Backfill ${DRY_RUN ? '(dry-run) ' : ''}complete.`);
	console.log(`  movies=${movieRows.length} watched=${watchedRows.length} logs=${logInputs.length}`);
}

main().catch((e) => {
	console.error('\n✗', e.message || e);
	process.exit(1);
});
