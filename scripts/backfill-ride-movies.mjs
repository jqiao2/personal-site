// One-time (resumable) backfill: link virtual bike rides to the film watched
// during them, read out of the notes.
//
// The owner rides the trainer with a movie on and writes "Ride movie: {name}"
// in the notes. This parses that line, searches TMDB for the film, and sets
// activities.movie_tmdb_id / movie_title (migration 0056) — the same two
// columns the editor's picker writes. The activity page then links to
// /films/movie/{id}, which lists that film's diary entries.
//
// Scope, deliberately narrow: only sport = 'virtual_ride', only rows not
// already linked (movie_tmdb_id is null), only notes that match the pattern.
// Idempotent — a linked row is skipped by the null filter, so a re-run is a
// no-op, and an unmatched search leaves the row untouched to be fixed by hand.
//
// Usage (env supplies SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY):
//   node --env-file=.env scripts/backfill-ride-movies.mjs [--dry-run]

const DRY_RUN = process.argv.includes('--dry-run');
const TMDB_KEY = process.env.TMDB_API_KEY;

/** Pull "{name}" (and an optional trailing year) out of a "Ride movie:" note. */
export function parseRideMovie(notes) {
	if (!notes) return null;
	const m = notes.match(/ride\s*movie\s*[:\-–]\s*(.+)/i);
	if (!m) return null;
	// Just the first line of the capture, trimmed of trailing punctuation.
	let title = m[1].split('\n')[0].trim().replace(/[.\s]+$/, '');
	let year = null;
	// Only a PARENTHESISED year is a year — a bare trailing number is usually part
	// of the title ("Blade Runner 2049", "1917", "2001: A Space Odyssey").
	const y = title.match(/\((\d{4})\)$/);
	if (y) {
		year = y[1];
		title = title.slice(0, y.index).trim();
	}
	return title ? { title, year } : null;
}

/** Drop the "Ride movie: …" line once linked — the link carries it now. Mirrors
 *  stripRideMovieNote in src/pages/activities/[id].astro. */
export function stripRideMovieNote(notes) {
	if (!notes) return notes ?? null;
	const out = notes
		.split('\n')
		.filter((line) => !/^\s*ride\s*movie\s*[:\-–]/i.test(line))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return out || null;
}

/** Best TMDB match for a title (+ optional year), or null. */
async function searchTmdb(title, year) {
	const url = new URL('https://api.themoviedb.org/3/search/movie');
	url.searchParams.set('api_key', TMDB_KEY);
	url.searchParams.set('query', title);
	url.searchParams.set('include_adult', 'false');
	if (year) url.searchParams.set('year', year);
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`TMDB ${res.status}`);
	const data = await res.json();
	const results = data.results ?? [];
	if (results.length === 0) return null;
	// Prefer an exact-year hit when a year was given; else TMDB's own ranking.
	const pick =
		(year && results.find((r) => (r.release_date || '').startsWith(year))) || results[0];
	return { id: pick.id, title: pick.title, year: (pick.release_date || '').slice(0, 4) };
}

async function main() {
	const SB_URL = process.env.SUPABASE_URL;
	const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!TMDB_KEY || !SB_URL || !SB_KEY) {
		console.error('Missing env: TMDB_API_KEY, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
		process.exit(1);
	}
	const { createClient } = await import('@supabase/supabase-js');
	const sb = createClient(SB_URL, SB_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});

	const { data: rows, error } = await sb
		.from('activities')
		.select('id, title, notes, movie_tmdb_id')
		.eq('sport', 'virtual_ride')
		.is('movie_tmdb_id', null)
		.is('deleted_at', null);
	if (error) throw error;

	const candidates = [];
	for (const r of rows) {
		const parsed = parseRideMovie(r.notes);
		if (parsed) candidates.push({ ...r, parsed });
	}

	console.log(`virtual rides unlinked: ${rows.length}`);
	console.log(`with a "Ride movie:" note: ${candidates.length}${DRY_RUN ? '  (dry run)' : ''}\n`);

	let linked = 0;
	let missed = 0;
	for (const c of candidates) {
		let hit = null;
		try {
			hit = await searchTmdb(c.parsed.title, c.parsed.year);
		} catch (e) {
			console.log(`  #${c.id} "${c.parsed.title}": search failed (${e.message})`);
			missed++;
			continue;
		}
		if (!hit) {
			console.log(`  #${c.id} "${c.parsed.title}"${c.parsed.year ? ` (${c.parsed.year})` : ''}: no TMDB match`);
			missed++;
			continue;
		}
		console.log(`  #${c.id} "${c.parsed.title}" → ${hit.title} (${hit.year}) [tmdb ${hit.id}]`);
		linked++;
		if (DRY_RUN) continue;
		const { error: upErr } = await sb
			.from('activities')
			.update({
				movie_tmdb_id: hit.id,
				movie_title: hit.title,
				notes: stripRideMovieNote(c.notes),
				updated_at: new Date().toISOString(),
			})
			.eq('id', c.id);
		if (upErr) throw new Error(`#${c.id}: ${upErr.message}`);
	}

	console.log(`\n${DRY_RUN ? 'would link' : 'linked'}: ${linked}   no match (left for hand-fix): ${missed}`);
}

// A tiny self-check on the parser — the one bit of logic that can silently
// mis-read a note. Runs only under `node scripts/backfill-ride-movies.mjs --test`.
if (process.argv.includes('--test')) {
	const cases = [
		['Ride movie: Dune', { title: 'Dune', year: null }],
		['ride movie: Blade Runner 2049 (2017)', { title: 'Blade Runner 2049', year: '2017' }],
		['Nice spin.\nRide movie: The Matrix.', { title: 'The Matrix', year: null }],
		['Ride movie - Blade Runner 2049', { title: 'Blade Runner 2049', year: null }],
		['no movie here', null],
	];
	for (const [note, want] of cases) {
		const got = parseRideMovie(note);
		const ok = JSON.stringify(got) === JSON.stringify(want);
		console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(note)} -> ${JSON.stringify(got)}`);
		if (!ok) process.exitCode = 1;
	}
	const stripCases = [
		['Ride movie: Dune', null],
		['Great spin.\nRide movie: The Matrix', 'Great spin.'],
		['Ride movie: X\n\nFelt strong', 'Felt strong'],
		['no movie line', 'no movie line'],
	];
	for (const [note, want] of stripCases) {
		const got = stripRideMovieNote(note);
		const ok = got === want;
		console.log(`${ok ? 'ok  ' : 'FAIL'} strip ${JSON.stringify(note)} -> ${JSON.stringify(got)}`);
		if (!ok) process.exitCode = 1;
	}
} else {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
