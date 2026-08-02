// One-time (resumable) backfill of TMDB genre + credit facts onto the `movies`
// cache, powering the Stats page and the Watchlist's genre filter.
//
// For every film in `watched` or `watchlist`, fetch TMDB details+credits and fill
// the columns added in migration 0008: genres, languages (spoken), countries
// (production), directors (crew job=Director) and actors (top ~10 billed), plus
// the release_date/release_year from 0014 and the premiere_date from 0019.
// `credits_synced_at` is stamped on success so re-runs skip already-done films —
// the script is safe to stop/resume.
//
// release_date/release_year prefer the US theatrical release (see
// preferredReleaseDate below), not TMDB's earliest-anywhere release_date. Because
// that's a value change to columns that are already populated — not a newly-added
// null column — re-deriving existing rows needs a one-time `--force` run; the
// `needsSync` heuristic below only catches never-synced or still-null rows.
// premiere_date keeps the earliest-anywhere date alongside it, for the YTS search.
//
// A film is otherwise due when it has never been synced, or when it predates a
// column added since its last sync (release_date, 0014; premiere_date, 0019) and so
// would still be null. That makes adding a column a matter of running this again,
// no --force.
//
// Usage (env supplies SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY):
//   node --env-file=.env scripts/backfill-credits.mjs [options]
//     --force        Re-fetch every film, even if already synced
//     --dry-run      Fetch + report, but write nothing to the DB
//     --limit=<n>    Only process the first n films (smoke test)
//
// Idempotent: each film's row is updated in place; re-running converges.

import { createClient } from '@supabase/supabase-js';

const args = new Set(process.argv.slice(2));
const getArg = (name) => {
	const hit = [...args].find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
};
const FORCE = args.has('--force');
const DRY_RUN = args.has('--dry-run');
const LIMIT = getArg('limit') ? Number.parseInt(getArg('limit'), 10) : Infinity;

const TMDB_KEY = process.env.TMDB_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!TMDB_KEY || !SB_URL || !SB_KEY) {
	console.error('Missing env: TMDB_API_KEY, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
	console.error('Run with:  node --env-file=.env scripts/backfill-credits.mjs');
	process.exit(1);
}

const CONCURRENCY = 8;
const TOP_CAST = 10;
const supabase = createClient(SB_URL, SB_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET TMDB details+credits, retrying on 429 (rate limit) with the Retry-After. */
async function fetchDetails(tmdbId) {
	const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
	url.searchParams.set('api_key', TMDB_KEY);
	url.searchParams.set('append_to_response', 'credits,release_dates');
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		if (res.status === 429) {
			const retry = Number.parseInt(res.headers.get('retry-after') || '1', 10);
			await sleep((Number.isFinite(retry) ? retry : 1) * 1000 + 250);
			continue;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`TMDB ${tmdbId} -> ${res.status} ${body.slice(0, 200)}`);
		}
		return res.json();
	}
	throw new Error(`TMDB ${tmdbId} rate-limited after retries`);
}

/** De-dupe a list of names while preserving order. */
function uniq(names) {
	const seen = new Set();
	const out = [];
	for (const raw of names) {
		const name = typeof raw === 'string' ? raw.trim() : '';
		if (name && !seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

/** Fallback ISO-639-1 → English name (mirror of LANGUAGE_NAMES in src/lib/tmdb.ts). */
const LANGUAGE_NAMES = {
	en: 'English', ja: 'Japanese', fr: 'French', ko: 'Korean', zh: 'Chinese',
	cn: 'Cantonese', es: 'Spanish', it: 'Italian', de: 'German', ru: 'Russian',
	hi: 'Hindi', pt: 'Portuguese', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
	fi: 'Finnish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', ar: 'Arabic',
	fa: 'Persian', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', he: 'Hebrew',
	cs: 'Czech', hu: 'Hungarian', el: 'Greek', ro: 'Romanian', uk: 'Ukrainian',
	ta: 'Tamil', te: 'Telugu', bn: 'Bengali', ml: 'Malayalam', mr: 'Marathi',
};

function originalLanguageName(d) {
	const code = d.original_language;
	if (!code) return null;
	const spoken = (d.spoken_languages ?? []).find((l) => l.iso_639_1 === code);
	return spoken?.english_name || spoken?.name || LANGUAGE_NAMES[code] || code.toUpperCase();
}

function usCertification(d) {
	const us = (d.release_dates?.results ?? []).find((r) => r.iso_3166_1 === 'US');
	const cert = (us?.release_dates ?? []).map((r) => (r.certification || '').trim()).find((c) => c);
	return cert || null;
}

/** TMDB release_dates `type` codes (mirror of RELEASE_TYPE in src/lib/tmdb.ts). */
const RELEASE_TYPE = { PREMIERE: 1, THEATRICAL_LIMITED: 2, THEATRICAL: 3 };

/** The "YYYY-MM-DD" of a per-country release_dates entry's ISO timestamp, or null. */
function releaseDatesDay(iso) {
	return /^\d{4}-\d{2}-\d{2}/.test(iso ?? '') ? iso.slice(0, 10) : null;
}

/** Mirror of preferredReleaseDate() in src/lib/tmdb.ts (kept in sync by hand):
 * US theatrical → US limited → US premiere → earliest premiere anywhere → TMDB's
 * top-level release_date. TMDB sends "" — not null — for an unknown date, which
 * releaseDatesDay/the regex reject so Postgres gets null. */
function preferredReleaseDate(d) {
	const results = d.release_dates?.results ?? [];
	const earliestOfType = (entries, type) =>
		entries
			.filter((e) => e.type === type)
			.map((e) => releaseDatesDay(e.release_date))
			.filter((day) => day != null)
			.sort()[0] ?? null;

	const us = results.find((r) => r.iso_3166_1 === 'US')?.release_dates ?? [];
	const usDate =
		earliestOfType(us, RELEASE_TYPE.THEATRICAL) ??
		earliestOfType(us, RELEASE_TYPE.THEATRICAL_LIMITED) ??
		earliestOfType(us, RELEASE_TYPE.PREMIERE);
	if (usDate) return usDate;

	const premiere = earliestOfType(results.flatMap((r) => r.release_dates), RELEASE_TYPE.PREMIERE);
	if (premiere) return premiere;

	return /^\d{4}-\d{2}-\d{2}$/.test(d.release_date ?? '') ? d.release_date : null;
}

/** Mirror of extractCreditFacts() in src/lib/tmdb.ts (kept in sync by hand).
 * release_year is derived from the same preferred date as release_date so the
 * two never disagree. premiere_date (0019) is TMDB's top-level release_date — the
 * earliest release anywhere — kept because that's the year YTS files films under;
 * see premiereDate() in src/lib/tmdb.ts. */
function extractFacts(d) {
	const releasedOn = preferredReleaseDate(d);
	return {
		release_date: releasedOn,
		release_year: releasedOn ? Number.parseInt(releasedOn.slice(0, 4), 10) : null,
		premiere_date: /^\d{4}-\d{2}-\d{2}$/.test(d.release_date ?? '') ? d.release_date : null,
		genres: uniq((d.genres ?? []).map((g) => g.name)),
		languages: uniq((d.spoken_languages ?? []).map((l) => l.english_name || l.name)),
		countries: uniq((d.production_countries ?? []).map((c) => c.name)),
		directors: uniq((d.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name)),
		actors: uniq((d.credits?.cast ?? []).slice(0, TOP_CAST).map((c) => c.name)),
		original_language: originalLanguageName(d),
		mpa_rating: usCertification(d),
	};
}

const COLUMNS = 'id, tmdb_id, title, credits_synced_at, release_date, premiere_date';

/** One relation's movie rows, paged past PostgREST's 1000-row cap. */
async function loadMoviesVia(table, orderBy) {
	const PAGE = 1000;
	const out = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabase
			.from(table)
			.select(`movies!inner(${COLUMNS})`)
			.order(orderBy, { ascending: false })
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(`load ${table} failed: ${error.message}`);
		const rows = (data ?? []).map((r) => r.movies);
		out.push(...rows);
		if (rows.length < PAGE) break;
	}
	return out;
}

/** Every film the site aggregates or filters over: watched ∪ watchlist. A film can
 * be in both (watchlisted, then watched without being removed), so de-dupe by id. */
async function loadMovies() {
	const [watched, watchlist] = await Promise.all([
		loadMoviesVia('watched', 'first_watched'),
		loadMoviesVia('watchlist', 'added_at'),
	]);
	const byId = new Map();
	for (const m of [...watched, ...watchlist]) byId.set(m.id, m);
	return { movies: [...byId.values()], watched: watched.length, watchlist: watchlist.length };
}

/** Whether a film still needs a TMDB fetch: never synced, or synced before a
 * column it would fill existed (release_date, migration 0014; premiere_date, 0019).
 *
 * The date tests re-fetch the handful of films TMDB has no date for on every run,
 * since a null there is indistinguishable from "not yet fetched". They cost a few
 * calls and converge to the same (null) value, which beats carrying a per-column
 * sync stamp just to skip them. Adding premiere_date is why every film is due once
 * after 0019 — no --force needed, unlike the US-theatrical change. */
function needsSync(m) {
	return !m.credits_synced_at || m.release_date == null || m.premiere_date == null;
}

async function main() {
	console.log(`Loading watched + watchlist films${DRY_RUN ? ' (dry run)' : ''}…`);
	const { movies: all, watched, watchlist } = await loadMovies();
	const todo = (FORCE ? all : all.filter(needsSync)).slice(
		0,
		Number.isFinite(LIMIT) ? LIMIT : all.length,
	);
	console.log(
		`${all.length} films (${watched} watched, ${watchlist} watchlisted); ` +
			`${todo.length} to sync${FORCE ? ' (forced)' : ''}` +
			(Number.isFinite(LIMIT) ? ` (limited to ${LIMIT})` : ''),
	);
	if (todo.length === 0) {
		console.log('Nothing to do — every film already has credits.');
		return;
	}

	let done = 0;
	let failed = 0;
	const failures = [];
	const now = () => new Date().toISOString();

	// Simple fixed-size worker pool over the todo queue.
	const queue = todo.slice();
	async function worker() {
		for (;;) {
			const movie = queue.shift();
			if (!movie) return;
			try {
				const details = await fetchDetails(movie.tmdb_id);
				const facts = extractFacts(details);
				if (!DRY_RUN) {
					const { error } = await supabase
						.from('movies')
						.update({ ...facts, credits_synced_at: now() })
						.eq('id', movie.id);
					if (error) throw new Error(error.message);
				}
				done++;
			} catch (e) {
				failed++;
				failures.push({ tmdb_id: movie.tmdb_id, title: movie.title, error: String(e.message || e) });
			}
			const n = done + failed;
			if (n % 25 === 0 || n === todo.length) {
				process.stdout.write(`\r  ${n}/${todo.length} (${failed} failed)   `);
			}
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	process.stdout.write('\n');

	console.log(`Done. Synced ${done}, failed ${failed}.`);
	if (failures.length) {
		console.log('Failures:');
		for (const f of failures.slice(0, 40)) console.log(`  ${f.tmdb_id} ${f.title}: ${f.error}`);
		if (failures.length > 40) console.log(`  …and ${failures.length - 40} more`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
