// One-time (resumable) backfill of TMDB genre + credit facts onto the `movies`
// cache, powering the Stats page.
//
// For every film in `watched`, fetch TMDB details+credits and fill the columns
// added in migration 0008: genres, languages (spoken), countries (production),
// directors (crew job=Director) and actors (top ~10 billed). `credits_synced_at`
// is stamped on success so re-runs skip already-done films — the script is safe
// to stop and resume, and only the first run makes the ~1.2k TMDB calls.
//
// Usage (env supplies SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY):
//   node --env-file=.env scripts/backfill-credits.mjs [options]
//     --force        Re-fetch every watched film, even if already synced
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

/** Mirror of extractCreditFacts() in src/lib/tmdb.ts (kept in sync by hand). */
function extractFacts(d) {
	return {
		genres: uniq((d.genres ?? []).map((g) => g.name)),
		languages: uniq((d.spoken_languages ?? []).map((l) => l.english_name || l.name)),
		countries: uniq((d.production_countries ?? []).map((c) => c.name)),
		directors: uniq((d.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name)),
		actors: uniq((d.credits?.cast ?? []).slice(0, TOP_CAST).map((c) => c.name)),
		original_language: originalLanguageName(d),
		mpa_rating: usCertification(d),
	};
}

/** Every watched film's movie row (paged past PostgREST's 1000-row cap). */
async function loadWatchedMovies() {
	const PAGE = 1000;
	const out = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await supabase
			.from('watched')
			.select('movies!inner(id, tmdb_id, title, credits_synced_at)')
			.order('first_watched', { ascending: false })
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(`load watched failed: ${error.message}`);
		const rows = (data ?? []).map((r) => r.movies);
		out.push(...rows);
		if (rows.length < PAGE) break;
	}
	return out;
}

async function main() {
	console.log(`Loading watched films${DRY_RUN ? ' (dry run)' : ''}…`);
	const all = await loadWatchedMovies();
	const todo = (FORCE ? all : all.filter((m) => !m.credits_synced_at)).slice(
		0,
		Number.isFinite(LIMIT) ? LIMIT : all.length,
	);
	console.log(
		`${all.length} watched films; ${todo.length} to sync${FORCE ? ' (forced)' : ''}` +
			(Number.isFinite(LIMIT) ? ` (limited to ${LIMIT})` : ''),
	);
	if (todo.length === 0) {
		console.log('Nothing to do — all watched films already have credits.');
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
