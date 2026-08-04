// Fill in a book's metadata from the ISBN already stored against it.
//
// The StoryGraph export carried an ISBN for nearly every book it brought in
// (migration 0024) and almost nothing else — no cover, no page count, no blurb.
// Matching those by hand means typing a query per book into a picker; matching
// them by ISBN means asking Open Library a question it can answer with a key.
//
// WHY NOT SEARCH. Open Library's /search.json is a Solr cluster that falls over
// regularly and answers 503 "No server is available" for hours at a time, while
// /isbn/… and /works/… are key lookups against a backend that stays up through
// those outages. Verified during the outage this script was written in: search
// 503'd or hung on every attempt while ISBN lookups returned in under a second.
//
// TITLES ARE NOT TOUCHED. Open Library's are frequently miscased ("The power
// broker: Robert Moses and the fall of New York") and the stored title came from
// an export that had it right. Covers, page counts, dates, subjects and blurbs
// are filled; naming stays a human decision (see fix-book-titles.mjs).
//
// Only ever fills what is missing. A book that already has a cover keeps it, and
// a page count is never overwritten — KOReader's is what the progress bars are
// measured against, and Open Library's median across editions would silently
// move every percentage on the site.
//
// Dry run by default. Nothing is written without --apply.
//
// Usage:
//   node --env-file=.env scripts/backfill-book-isbn.mjs            # show
//   node --env-file=.env scripts/backfill-book-isbn.mjs --apply    # write
//
//   --id <id>       one book only
//   --limit <n>     stop after n books
//   --force         re-fetch books that already have an ol_key

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (try: node --env-file=.env …)');
	process.exit(1);
}

const UA = 'jqiao-personal-site/1.0 (reading log; https://jqiao.vercel.app)';

/** Open Library is volunteer-run and this is a bulk job. One book a second. */
const DELAY_MS = 1000;
/** Long enough for a slow answer, short enough not to hang the whole run. */
const TIMEOUT_MS = 15_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : null;
};

const apply = flag('--apply');
const force = flag('--force');
const onlyId = value('--id') ? Number(value('--id')) : null;
const limit = value('--limit') ? Number(value('--limit')) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db(path, init = {}) {
	const res = await fetch(`${SUPA}/rest/v1/${path}`, {
		...init,
		headers: {
			apikey: KEY,
			authorization: `Bearer ${KEY}`,
			'content-type': 'application/json',
			...(init.headers ?? {}),
		},
	});
	if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
	return res.status === 204 ? null : res.json();
}

async function ol(url) {
	const res = await fetch(url, {
		headers: { accept: 'application/json', 'user-agent': UA },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Open Library returned ${res.status}`);
	return res.json();
}

/** Subjects, thinned the same way src/lib/openlibrary.ts thins them. */
function subjects(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	const out = [];
	for (const value of raw) {
		if (typeof value !== 'string') continue;
		const s = value.trim();
		if (!s || s.length > 28) continue;
		if (/[,()[\]/]|--|\d/.test(s)) continue;
		if (/^(fiction|non-?fiction)$/i.test(s)) continue;
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s[0].toUpperCase() + s.slice(1));
		if (out.length >= 4) break;
	}
	return out;
}

function classify(raw) {
	if (!Array.isArray(raw)) return null;
	const all = raw.filter((s) => typeof s === 'string').join(' | ').toLowerCase();
	if (!all) return null;
	// Mirrors src/lib/openlibrary.ts, including the order: an explicit
	// "nonfiction" outranks everything, then fiction markers, then the softer
	// history/biography words — otherwise Emma ("Historical Fiction") and
	// Foundation ("Psychohistory") both come back as nonfiction.
	if (/non-?fiction/.test(all)) return 'Nonfiction';
	if (/fiction|novel|stories|poetry/.test(all)) return 'Fiction';
	if (/biography|history|essays|memoir/.test(all)) return 'Nonfiction';
	return null;
}

function paragraphs(raw) {
	const text = typeof raw === 'string' ? raw : typeof raw?.value === 'string' ? raw.value : '';
	if (!text) return [];
	return text
		.split(/-{4,}/)[0]
		.split(/\r?\n\s*\r?\n/)
		.map((p) => p.replace(/\s+/g, ' ').trim())
		.filter((p) => p.length > 0);
}

async function lookup(isbn) {
	const clean = String(isbn).replace(/[^0-9Xx]/g, '').toUpperCase();
	if (clean.length !== 10 && clean.length !== 13) return null;

	const edition = await ol(`https://openlibrary.org/isbn/${clean}.json`);
	if (!edition) return null;

	const workKey = edition.works?.[0]?.key ?? null;
	if (!workKey) return null;

	let work = {};
	try {
		work = (await ol(`https://openlibrary.org${workKey}.json`)) ?? {};
	} catch {
		// The edition alone is a usable match.
	}

	const coverId =
		edition.covers?.find((c) => typeof c === 'number' && c > 0) ??
		work.covers?.find((c) => typeof c === 'number' && c > 0) ??
		null;

	return {
		key: workKey,
		subtitle: typeof edition.subtitle === 'string' ? edition.subtitle : null,
		pages: typeof edition.number_of_pages === 'number' ? edition.number_of_pages : null,
		coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
		firstPublished:
			(typeof work.first_publish_date === 'string' ? work.first_publish_date : null) ??
			(typeof edition.publish_date === 'string' ? edition.publish_date : null),
		description: paragraphs(work.description),
		genres: subjects(work.subjects),
		kind: classify(work.subjects),
	};
}

const select = 'id,title,isbn,ol_key,cover_url,total_pages,subtitle,first_published';
let query = `books?select=${select}&isbn=not.is.null&order=id`;
if (!force) query += '&ol_key=is.null';
if (onlyId) query += `&id=eq.${onlyId}`;

const books = await db(query);
const targets = limit ? books.slice(0, limit) : books;

console.log(`${targets.length} book${targets.length === 1 ? '' : 's'} with an ISBN and no match${apply ? '' : '  (dry run — pass --apply to write)'}\n`);

let matched = 0;
let missing = 0;
let failed = 0;

for (const [i, book] of targets.entries()) {
	if (i > 0) await sleep(DELAY_MS);

	let found;
	try {
		found = await lookup(book.isbn);
	} catch (e) {
		failed++;
		console.log(`  ✗ ${book.title} — ${e.message}`);
		continue;
	}

	if (!found) {
		missing++;
		console.log(`  – ${book.title} — nothing at ISBN ${book.isbn}`);
		continue;
	}

	// Only what is absent. See the header: an existing cover or page count is
	// better evidence than a median across editions.
	const patch = {
		ol_key: found.key,
		...(book.cover_url || !found.coverUrl ? {} : { cover_url: found.coverUrl }),
		...(book.total_pages || !found.pages ? {} : { total_pages: found.pages }),
		...(book.subtitle || !found.subtitle ? {} : { subtitle: found.subtitle }),
		...(book.first_published || !found.firstPublished
			? {}
			: { first_published: found.firstPublished }),
		...(found.description.length ? { description: found.description } : {}),
		...(found.genres.length ? { genres: found.genres } : {}),
		...(found.kind ? { kind: found.kind } : {}),
	};

	matched++;
	const gained = [
		patch.cover_url ? 'cover' : null,
		patch.total_pages ? `${patch.total_pages}pp` : null,
		patch.first_published ? patch.first_published : null,
		patch.kind ?? null,
		patch.genres ? `${patch.genres.length} subjects` : null,
		patch.description ? 'blurb' : null,
	].filter(Boolean);
	console.log(`  ✓ ${book.title} — ${found.key}${gained.length ? ` · ${gained.join(', ')}` : ' · nothing new'}`);

	if (apply) {
		await db(`books?id=eq.${book.id}`, {
			method: 'PATCH',
			headers: { prefer: 'return=minimal' },
			body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
		});
	}
}

console.log(`\n${matched} matched, ${missing} not in Open Library, ${failed} failed${apply ? '' : ' — nothing written'}`);
