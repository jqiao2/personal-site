// Turn KOReader's filename-derived book titles into readable ones.
//
// Sideloaded EPUBs carry no real metadata, so KOReader falls back to the
// filename, which has been through a Calibre-style mangling:
//
//   "Martian_ A Novel, The - Andy Weir"
//     -> title "The Martian: A Novel", authors "Andy Weir"
//   "Power Broker_ Robert Moses and the Fall of New York, The - Robert A. Caro"
//     -> title "The Power Broker: Robert Moses and the Fall of New York",
//        authors "Robert A. Caro"
//
// Three transformations, each undoing something a filesystem required:
//   1. " - Author" welded onto the end, because a filename has one field.
//   2. "_" where a colon was, because colons are illegal in filenames.
//   3. ", The" moved to the end, because that is how a library sorts.
//
// Writes to `display_title` / `display_authors`, never to `title` — the sync
// endpoint overwrites `title` on every run by design, so an edit there would
// silently revert the next time the Kindle connects (migration 0022).
//
// Dry run by default. Nothing is written without --apply, because a heuristic
// over someone's library should be looked at before it is trusted.
//
// Usage:
//   node --env-file=.env scripts/fix-book-titles.mjs            # show
//   node --env-file=.env scripts/fix-book-titles.mjs --apply    # write
//   node --env-file=.env scripts/fix-book-titles.mjs --reset    # clear overrides
//
//   --md5 <md5>        restrict to one book
//   --title  "…"       set the title by hand (with --md5)
//   --authors "…"      set the authors by hand (with --md5)

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (try: node --env-file=.env …)');
	process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const apply = !!args.apply;
const only = typeof args.md5 === 'string' ? args.md5.toLowerCase() : null;

const books = await rest(
	`books?select=md5,title,authors,display_title,display_authors${only ? `&md5=eq.${only}` : ''}&order=id`,
);
if (books.length === 0) {
	console.log(only ? `no book with md5 ${only}` : 'no books');
	process.exit(0);
}

// --- manual override --------------------------------------------------------
if (typeof args.title === 'string' || typeof args.authors === 'string') {
	if (!only) {
		console.error('--title/--authors need --md5 to say which book');
		process.exit(1);
	}
	const patch = {};
	if (typeof args.title === 'string') patch.display_title = args.title || null;
	if (typeof args.authors === 'string') patch.display_authors = args.authors || null;
	show(books[0], { ...books[0], ...patch });
	if (apply) {
		await rest(`books?md5=eq.${only}`, { method: 'PATCH', body: JSON.stringify(patch) });
		console.log('\napplied');
	} else {
		console.log('\ndry run — pass --apply to write');
	}
	process.exit(0);
}

// --- reset ------------------------------------------------------------------
if (args.reset) {
	for (const b of books) {
		if (b.display_title || b.display_authors) {
			console.log(`clearing override on ${JSON.stringify(b.title)}`);
			if (apply) {
				await rest(`books?md5=eq.${b.md5}`, {
					method: 'PATCH',
					body: JSON.stringify({ display_title: null, display_authors: null }),
				});
			}
		}
	}
	console.log(apply ? '\napplied' : '\ndry run — pass --apply to write');
	process.exit(0);
}

// --- the heuristic ----------------------------------------------------------
let changed = 0;
for (const b of books) {
	const suggestion = clean(b.title, b.authors);
	const next = {
		display_title: suggestion.title === b.title ? null : suggestion.title,
		display_authors: suggestion.authors,
	};

	if (next.display_title === (b.display_title ?? null) && next.display_authors === (b.display_authors ?? null)) {
		console.log(`  unchanged  ${JSON.stringify(b.title)}`);
		continue;
	}
	changed++;
	show(b, { ...b, ...next });
	if (apply) {
		await rest(`books?md5=eq.${b.md5}`, { method: 'PATCH', body: JSON.stringify(next) });
	}
}

console.log(
	changed === 0
		? '\nnothing to change'
		: apply
			? `\napplied to ${changed} book(s)`
			: `\ndry run — ${changed} book(s) would change. Pass --apply to write.`,
);

// ---------------------------------------------------------------------------

/**
 * Undo the filename mangling. Returns { title, authors }; `authors` is null
 * when nothing could be split off with confidence.
 */
function clean(rawTitle, existingAuthors) {
	let title = String(rawTitle ?? '').trim();
	let authors = null;

	// 1. " - Author" at the end. Only when the book has no author already —
	//    a real title can contain " - ", and existing metadata outranks a guess.
	if (!existingAuthors) {
		const at = title.lastIndexOf(' - ');
		if (at > 0) {
			const head = title.slice(0, at).trim();
			const tail = title.slice(at + 3).trim();
			if (head.length > 0 && looksLikeAuthors(tail)) {
				title = head;
				authors = tail;
			}
		}
	}

	// 2. "_" standing in for a colon. Only "Word_ Word" — an underscore with a
	//    space after it. A bare underscore inside a word is not punctuation.
	title = title.replace(/_\s+/g, ': ');

	// 3. Trailing article, from library sort order: "Martian: A Novel, The".
	//    The article belongs at the very front, before the colon clause.
	const article = title.match(/^(.*?),\s+(The|A|An)$/i);
	if (article) {
		title = `${capitalise(article[2])} ${article[1].trim()}`;
	}

	return { title: title.replace(/\s+/g, ' ').trim(), authors };
}

/**
 * Does this look like a person or a list of people, rather than the back half
 * of a hyphenated title? Letters, spaces and name punctuation only, with "&",
 * "and" or commas joining them.
 */
function looksLikeAuthors(s) {
	if (s.length === 0 || s.length > 70) return false;
	if (/[:_\d]/.test(s)) return false;
	if (!/^\p{Lu}/u.test(s)) return false;
	return /^[\p{L}.'’\-\s]+(?:\s*(?:&|and|,)\s*[\p{L}.'’\-\s]+)*$/u.test(s);
}

function capitalise(s) {
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function show(before, after) {
	const oldTitle = before.display_title ?? before.title;
	const newTitle = after.display_title ?? after.title;
	console.log(`\n  ${JSON.stringify(oldTitle)}`);
	console.log(`    title   -> ${JSON.stringify(newTitle)}`);
	console.log(
		`    authors -> ${JSON.stringify(after.display_authors ?? after.authors ?? null)}` +
			(before.display_authors || before.authors ? ` (was ${JSON.stringify(before.display_authors ?? before.authors)})` : ''),
	);
}

async function rest(path, init = {}) {
	const res = await fetch(`${SUPA}/rest/v1/${path}`, {
		...init,
		headers: {
			apikey: KEY,
			authorization: `Bearer ${KEY}`,
			'content-type': 'application/json',
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	if (!res.ok) {
		console.error(`${res.status} ${path}: ${text}`);
		process.exit(1);
	}
	return text ? JSON.parse(text) : null;
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
