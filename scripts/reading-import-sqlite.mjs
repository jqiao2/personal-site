// Import a KOReader statistics.sqlite3 straight off the Kindle over USB.
//
// The hands-off path is a KOReader plugin that POSTs on document close; this is
// the path that needs no code running on the device. Plug the Kindle in, point
// this at koreader/settings/statistics.sqlite3, and it does the same thing the
// plugin will: read the stats, translate them to /api/reading/sync's contract,
// and send them in chunks.
//
// Two things it has to do that a naive dump would not:
//
//   1. Join page_stat_data to book. KOReader keys page stats by `id_book`, a
//      local autoincrement that means nothing on the server — the stable
//      identifier is the book's md5, which only exists on the `book` row.
//
//   2. Drop rows the API would reject. A real stats database accumulates
//      damage: page 0 from an interrupted layout, a timestamp from a session
//      where the clock hadn't synced yet. The endpoint 400s a whole batch over
//      one bad row (deliberately — a silent partial insert is worse), so the
//      filtering belongs here, out loud, with a count of what was dropped and
//      why.
//
// Resumable by default: it asks the endpoint for its cursor and sends only what
// came after. Re-running is harmless regardless — the unique constraint on
// (book_id, page, started_at) discards anything already stored, which is why
// the cutoff is deliberately inclusive rather than clever.
//
// The database is opened read-only. It is the only copy of your reading history.
//
// Usage:
//   node --env-file=.env scripts/reading-import-sqlite.mjs --db <path> [options]
//
// Options:
//   --db PATH       statistics.sqlite3 (required). On a mounted Kindle this is
//                   <drive>/koreader/settings/statistics.sqlite3
//   --url BASE      Target site (default http://localhost:4321)
//   --device NAME   Device label stored on every session (default kindle-pw5)
//   --chunk N       Sessions per request (default 2000, endpoint caps at 5000)
//   --since DATE    Only sessions on/after YYYY-MM-DD (local)
//   --all           Ignore the resume cursor; offer everything
//   --dry-run       Read and report, send nothing
//   --out FILE      Write the whole payload to FILE as JSON
//
// Env: READING_SYNC_TOKEN (bearer token for the endpoint)

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const MAX_CHUNK = 5000; // the endpoint's cap
const FUTURE_TOLERANCE_SECONDS = 24 * 60 * 60;

const args = parseArgs(process.argv.slice(2));
if (!args.db || args.db === true) {
	console.error('--db <path to statistics.sqlite3> is required');
	process.exit(1);
}

const opts = {
	db: String(args.db),
	url: String(args.url ?? 'http://localhost:4321'),
	device: String(args.device ?? 'kindle-pw5'),
	chunk: Math.min(int(args.chunk, 2000), MAX_CHUNK),
	since: typeof args.since === 'string' ? args.since : null,
	all: !!args.all,
	dryRun: !!args['dry-run'],
	out: typeof args.out === 'string' ? args.out : null,
};

const { books, sessions, skipped, counts } = readStats(opts.db);

console.log(`read ${opts.db}`);
console.log(`  books:    ${counts.books} (${books.length} usable)`);
console.log(`  sessions: ${counts.sessions} (${sessions.length} usable)`);
if (skipped.total > 0) {
	console.log('  skipped:');
	for (const [reason, n] of Object.entries(skipped.byReason)) {
		console.log(`    ${String(n).padStart(6)}  ${reason}`);
	}
}

let toSend = sessions;

if (opts.since) {
	const cutoff = Math.floor(Date.parse(`${opts.since}T00:00:00Z`) / 1000);
	if (!Number.isFinite(cutoff)) {
		console.error(`--since must be YYYY-MM-DD, got ${opts.since}`);
		process.exit(1);
	}
	toSend = toSend.filter((s) => s.start_time >= cutoff);
	console.log(`  --since ${opts.since}: ${toSend.length} sessions`);
}

if (!opts.all && !opts.dryRun) {
	const cursor = await getCursor();
	if (cursor?.latest_session_at) {
		// Inclusive: a row landing on the same second as the cursor would
		// otherwise be skipped forever. Resending it costs one discarded insert.
		const cutoff = Math.floor(Date.parse(cursor.latest_session_at) / 1000);
		const before = toSend.length;
		toSend = toSend.filter((s) => s.start_time >= cutoff);
		console.log(
			`  cursor at ${cursor.latest_session_at} (${cursor.session_count} stored): ` +
				`${before} -> ${toSend.length} to offer`,
		);
	} else {
		console.log('  no cursor yet, sending everything');
	}
}

if (opts.out) {
	const payload = { device: opts.device, books: booksFor(toSend), sessions: toSend };
	writeFileSync(opts.out, JSON.stringify(payload, null, 2));
	console.log(`wrote ${opts.out}`);
}

if (opts.dryRun) {
	const chunks = Math.ceil(toSend.length / opts.chunk) || 0;
	console.log(`\ndry run: would send ${toSend.length} sessions in ${chunks} request(s)`);
	printRange(toSend);
	process.exit(0);
}

if (toSend.length === 0) {
	console.log('\nnothing new to send');
	process.exit(0);
}

printRange(toSend);

let received = 0;
let inserted = 0;
let latest = null;

console.log();
for (let i = 0; i < toSend.length; i += opts.chunk) {
	const slice = toSend.slice(i, i + opts.chunk);
	const n = Math.floor(i / opts.chunk) + 1;
	const total = Math.ceil(toSend.length / opts.chunk);
	const result = await post({ device: opts.device, books: booksFor(slice), sessions: slice });
	received += result.sessions_received;
	inserted += result.sessions_inserted;
	latest = result.latest_session_at ?? latest;
	console.log(
		`  chunk ${n}/${total}: ${result.sessions_received} sent, ` +
			`${result.sessions_inserted} new, ${result.books_upserted} book(s)`,
	);
}

console.log(`\nsent ${received} sessions, ${inserted} new (${received - inserted} already stored)`);
console.log(`cursor now ${latest}`);

// ---------------------------------------------------------------------------

function readStats(path) {
	const db = new DatabaseSync(path, { readOnly: true });

	// page_stat_data is the modern table; older KOReader wrote page_stat, which
	// current versions keep as a view over it. Either way the columns match.
	const tables = db
		.prepare(`select name from sqlite_master where name in ('page_stat_data', 'page_stat')`)
		.all()
		.map((r) => r.name);
	const statsTable = tables.includes('page_stat_data') ? 'page_stat_data' : tables[0];
	if (!statsTable) {
		console.error(`${path} has no page_stat_data table — is this a KOReader statistics database?`);
		process.exit(1);
	}

	const bookRows = db.prepare(`select id, title, authors, series, language, md5, pages from book`).all();
	const sessionRows = db
		.prepare(`select id_book, page, start_time, duration, total_pages from ${statsTable} order by start_time`)
		.all();
	db.close();

	const skipped = { total: 0, byReason: {} };
	const skip = (reason) => {
		skipped.total++;
		skipped.byReason[reason] = (skipped.byReason[reason] ?? 0) + 1;
	};

	// id -> md5, the join the server can't do for us.
	const md5ById = new Map();
	const books = [];
	for (const b of bookRows) {
		const md5 = str(b.md5)?.toLowerCase();
		if (!md5) {
			skip('book has no md5');
			continue;
		}
		md5ById.set(b.id, md5);
		books.push({
			md5,
			// A book with no title still has a reading history worth keeping; give
			// it something addressable rather than dropping it.
			title: str(b.title) ?? `Untitled (${md5.slice(0, 8)})`,
			authors: str(b.authors),
			series: str(b.series),
			language: str(b.language),
			total_pages: posInt(b.pages),
		});
	}

	const now = Math.floor(Date.now() / 1000);
	const sessions = [];
	for (const s of sessionRows) {
		const md5 = md5ById.get(s.id_book);
		if (!md5) {
			skip('session references an unknown book');
			continue;
		}
		const page = Number(s.page);
		if (!Number.isInteger(page) || page <= 0) {
			skip('page is not a positive integer');
			continue;
		}
		const startTime = Number(s.start_time);
		if (!Number.isInteger(startTime) || startTime <= 0) {
			skip('start_time is missing or zero');
			continue;
		}
		if (startTime > now + FUTURE_TOLERANCE_SECONDS) {
			skip('start_time is in the future (device clock)');
			continue;
		}
		const duration = Number(s.duration);
		if (!Number.isInteger(duration) || duration < 0) {
			skip('duration is negative or not a number');
			continue;
		}
		sessions.push({
			book_md5: md5,
			page,
			start_time: startTime,
			duration,
			total_pages: posInt(s.total_pages),
			device: opts.device,
		});
	}

	return {
		books,
		sessions,
		skipped,
		counts: { books: bookRows.length, sessions: sessionRows.length },
	};
}

/** Only the books a given slice of sessions actually mentions. */
function booksFor(slice) {
	const wanted = new Set(slice.map((s) => s.book_md5));
	return books.filter((b) => wanted.has(b.md5));
}

function printRange(list) {
	if (list.length === 0) return;
	const first = new Date(list[0].start_time * 1000);
	const last = new Date(list[list.length - 1].start_time * 1000);
	const titles = new Set(list.map((s) => s.book_md5));
	console.log(
		`  ${list.length} sessions across ${titles.size} book(s), ` +
			`${first.toISOString().slice(0, 10)} to ${last.toISOString().slice(0, 10)}`,
	);
}

function token() {
	const t = process.env.READING_SYNC_TOKEN;
	if (!t) {
		console.error('READING_SYNC_TOKEN is not set (try: node --env-file=.env …)');
		process.exit(1);
	}
	return t;
}

async function getCursor() {
	const url = new URL(`/api/reading/sync?device=${encodeURIComponent(opts.device)}`, opts.url);
	const res = await fetch(url, { headers: { authorization: `Bearer ${token()}` } });
	if (!res.ok) {
		console.error(`cursor lookup failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
		process.exit(1);
	}
	return res.json();
}

async function post(payload) {
	const url = new URL('/api/reading/sync', opts.url);
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify(payload),
	});
	const text = await res.text();
	if (!res.ok) {
		console.error(`\nPOST failed: ${res.status} ${text.slice(0, 400)}`);
		process.exit(1);
	}
	return JSON.parse(text);
}

// --- misc -------------------------------------------------------------------

/**
 * Trimmed non-empty string, or null.
 *
 * KOReader writes the literal string "N/A" where an EPUB has no metadata, so a
 * straight read stores books by an author named N/A in a language called N/A.
 * The schema already treats absent values as clean omissions; this is where a
 * placeholder becomes an absence.
 */
function str(v) {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	if (t.length === 0 || t.toUpperCase() === 'N/A') return null;
	return t;
}

function posInt(v) {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function int(v, fallback) {
	const n = Number.parseInt(String(v), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
