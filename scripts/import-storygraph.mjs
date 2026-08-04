// One-shot import of a StoryGraph CSV export into the reading tracker.
//
// StoryGraph was the previous book log, and it holds years of reading the Kindle
// never saw: books read on paper, rated and reviewed, plus a to-read pile that
// had been accumulating since 2021. None of it has a file, an md5 or a single
// page turn, which is most of what migration 0024 exists to accommodate.
//
// Matching against what is already here is by TITLE, normalised. There is no
// shared identifier: KOReader knows an md5 of a file, StoryGraph knows an ISBN
// of an edition, and the three books that appear in both arrived by different
// routes. Titles are compared with articles, punctuation and subtitles stripped,
// and every match is printed in the dry run to be looked at.
//
// The import is idempotent. Books are matched before insert, `added_at` and
// `finished_at` are only written where they are absent, and reviews upsert on
// (book_id, read_from) — which is the same key the review API uses, so running
// this twice changes nothing the second time.
//
// Dry run by default:
//   node --env-file=.env scripts/import-storygraph.mjs <export.csv>
//   node --env-file=.env scripts/import-storygraph.mjs <export.csv> --apply
//
//   --verbose   print every row's mapping, not just the ones that need a look

import { readFileSync } from 'node:fs';

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (try: node --env-file=.env …)');
	process.exit(1);
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const verbose = argv.includes('--verbose');
const csvPath = argv.find((a) => !a.startsWith('--'));
if (!csvPath) {
	console.error('usage: node --env-file=.env scripts/import-storygraph.mjs <export.csv> [--apply]');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Vocabulary translation
// ---------------------------------------------------------------------------
// StoryGraph's mood list and this site's are different vocabularies describing
// the same thing, and the mapping was chosen by hand (see src/lib/book-queries.ts,
// whose MOODS/TONES were adjusted to meet this halfway). Two StoryGraph terms
// land on 'Inspiring' — "hopeful" has no separate home here — which is the one
// place the import collapses a distinction rather than carrying it across.
const MOOD_MAP = {
	adventurous: 'Adventurous',
	dark: 'Dark',
	emotional: 'Emotional',
	funny: 'Funny',
	hopeful: 'Inspiring',
	informative: 'Informative',
	inspiring: 'Inspiring',
	mysterious: 'Mysterious',
	reflective: 'Reflective',
	sad: 'Sad',
	tense: 'Tense',
};

// Which of the two lists each term belongs to, so the review row splits the way
// the editor expects.
const MOODS = new Set(['Cozy', 'Inspiring', 'Emotional', 'Funny', 'Dark', 'Tense', 'Mysterious', 'Sad', 'Magical', 'Nostalgic', 'Bittersweet']);

const PACE_MAP = { fast: 'Fast', medium: 'Moderate', slow: 'Slow' };
const FOCUS_MAP = { Character: 'Character-Driven', 'A mix': 'A bit of both', Plot: 'Plot-Driven' };

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
const rows = parseCsv(readFileSync(csvPath, 'utf8'));
if (!rows.length) {
	console.error('no rows in CSV');
	process.exit(1);
}

const existing = await rest('books?select=id,md5,title,display_title,added_at,finished_at,gave_up_at,isbn,contributors&order=id');
const byKey = new Map(existing.map((b) => [titleKey(b.display_title ?? b.title), b]));

const notes = [];
const plan = { insert: [], patch: [], reviews: [] };

for (const row of rows) {
	const title = (row.Title ?? '').trim();
	if (!title) continue;

	const status = row['Read Status'];
	const match = byKey.get(titleKey(title));
	const dates = readDates(row);
	const isbn = digits(row['ISBN/UID']);
	const contributors = splitContributors(row.Contributors);

	// --- what shelf does this land on ------------------------------------------
	// `added_at` is the to-read pile and `finished_at` is the finished shelf; the
	// two in-between states have nowhere honest to go without page turns, so they
	// land on the pile and say so in the notes.
	const addedAt = stamp(row['Date Added']);
	let finishedAt = null;

	if (status === 'read') {
		if (dates) {
			finishedAt = stamp(dates.to);
		} else {
			// No dates at all. Falls back to Date Added so the rating and review
			// survive — book_reviews.read_from/read_to are NOT NULL.
			finishedAt = addedAt;
			notes.push(`${title}: marked read with no dates — dated to its Date Added (${row['Date Added']}).`);
		}
	} else if (status === 'currently-reading' || status === 'paused') {
		notes.push(
			`${title}: StoryGraph says "${status}", but with no page turns there is nothing to show progress from — left on the to-read pile, where the first sync will move it.`,
		);
	}

	const wanted = {
		title,
		authors: (row.Authors ?? '').trim() || null,
		isbn,
		contributors,
		added_at: addedAt,
		finished_at: finishedAt,
		finished_by_hand: !!finishedAt,
	};

	if (!match) {
		plan.insert.push({ row, wanted });
	} else {
		// Only ever fills blanks. The three books that overlap are already tracked
		// by the Kindle, and StoryGraph's copy of their state is the stale one —
		// The Power Broker is filed there as "to-read" and is being read right now.
		const patch = {};
		if (wanted.added_at && !match.added_at) patch.added_at = wanted.added_at;
		if (wanted.isbn && !match.isbn) patch.isbn = wanted.isbn;
		if (wanted.contributors.length && !(match.contributors ?? []).length) {
			patch.contributors = wanted.contributors;
		}
		// finished_at is deliberately NOT patched onto a tracked book: progress
		// already decides that one, and writing it here would flip the automatic
		// finish into a hand-set one for no gain.
		if (Object.keys(patch).length) plan.patch.push({ row, match, patch });
		else if (verbose) console.log(`  unchanged   ${title}`);
	}

	// --- the review -------------------------------------------------------------
	const review = buildReview(row, dates, finishedAt);
	if (review) plan.reviews.push({ title, review, existingId: match?.id ?? null });

	// A re-read is two rows in book_reviews, keyed on their date ranges — and the
	// export gives one range no matter how many times a book was read, so the
	// second read cannot be reconstructed from it.
	const count = Number(row['Read Count']);
	if (count > 1) {
		notes.push(
			`${title}: Read Count is ${count} but the export carries only one date range, so it imports as a single read. The second review row has to be added by hand.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\n${rows.length} rows · ${existing.length} books already here\n`);

console.log(`── ${plan.insert.length} new books ──`);
for (const { wanted } of plan.insert) {
	const shelf = wanted.finished_at ? 'finished' : wanted.added_at ? 'to-read' : 'unfiled';
	console.log(`  + ${pad(shelf, 9)} ${wanted.title}${wanted.authors ? ` — ${wanted.authors}` : ''}`);
}

console.log(`\n── ${plan.patch.length} existing books patched ──`);
for (const { match, patch } of plan.patch) {
	console.log(`  ~ ${match.display_title ?? match.title}: ${JSON.stringify(patch)}`);
}

const withText = plan.reviews.filter((r) => r.review.review_text).length;
console.log(`\n── ${plan.reviews.length} reviews (${withText} with written text) ──`);
for (const { title, review } of plan.reviews) {
	const bits = [
		review.rating != null ? `${review.rating}★` : 'unrated',
		`${review.read_from}→${review.read_to}`,
		review.pacing,
		review.focus,
		[...review.moods, ...review.tones].join('/') || null,
	].filter(Boolean);
	console.log(`  · ${pad(title.slice(0, 42), 44)} ${bits.join('  ')}`);
	if (review.review_text) console.log(`      “${review.review_text}”`);
}

if (notes.length) {
	console.log(`\n── ${notes.length} things worth knowing ──`);
	for (const n of notes) console.log(`  ! ${n}`);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
// Returning rather than process.exit: the report above is several hundred lines
// and exiting out from under a stdout that has not drained aborts the process on
// Windows, which makes a clean dry run look like a crash.
if (!apply) {
	console.log('\ndry run — pass --apply to write');
} else {
	await write();
}

async function write() {
const idByTitle = new Map(existing.map((b) => [titleKey(b.display_title ?? b.title), b.id]));

for (const { wanted } of plan.insert) {
	// display_title as well as title: `title` is the sync endpoint's column and
	// would be overwritten if this book ever turned up on the Kindle under a
	// mangled filename. The correction has to be the one that survives (0022).
	const created = await rest('books', {
		method: 'POST',
		headers: { prefer: 'return=representation' },
		body: JSON.stringify({
			md5: null,
			title: wanted.title,
			display_title: wanted.title,
			authors: wanted.authors,
			display_authors: wanted.authors,
			isbn: wanted.isbn,
			contributors: wanted.contributors,
			added_at: wanted.added_at,
			finished_at: wanted.finished_at,
			finished_by_hand: wanted.finished_by_hand,
		}),
	});
	idByTitle.set(titleKey(wanted.title), created[0].id);
}
console.log(`\ninserted ${plan.insert.length} books`);

for (const { match, patch } of plan.patch) {
	await rest(`books?id=eq.${match.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
console.log(`patched ${plan.patch.length} books`);

let saved = 0;
for (const { title, review } of plan.reviews) {
	const bookId = idByTitle.get(titleKey(title));
	if (!bookId) {
		console.error(`  ! no book id for ${title} — review skipped`);
		continue;
	}
	await rest('book_reviews?on_conflict=book_id,read_from', {
		method: 'POST',
		headers: { prefer: 'resolution=merge-duplicates' },
		body: JSON.stringify({ book_id: bookId, ...review }),
	});
	saved++;
}
console.log(`saved ${saved} reviews\n`);
}

// ---------------------------------------------------------------------------

/** The review for a read, or null when there is nothing to record. */
function buildReview(row, dates, finishedAt) {
	const rating = row['Star Rating'] ? Number(row['Star Rating']) : null;
	const text = stripHtml(row.Review);
	const moods = mapMoods(row.Moods);
	const pacing = PACE_MAP[(row.Pace ?? '').trim()] ?? null;
	const focus = FOCUS_MAP[(row['Character- or Plot-Driven?'] ?? '').trim()] ?? null;

	// Only books that were actually read get a review row, and only when there is
	// something in it. A to-read book with no opinion attached is a book, not a
	// blank review.
	if (row['Read Status'] !== 'read') return null;
	if (rating == null && !text && !moods.length && !pacing && !focus) return null;

	const from = dates ? dates.from : finishedAt?.slice(0, 10);
	const to = dates ? dates.to : finishedAt?.slice(0, 10);
	if (!from || !to) return null;

	return {
		read_from: from,
		read_to: to,
		rating,
		loved: false,
		gave_up: false,
		review_text: text,
		pacing,
		focus,
		moods: moods.filter((m) => MOODS.has(m)),
		tones: moods.filter((m) => !MOODS.has(m)),
	};
}

/** StoryGraph's comma-separated mood list, translated and de-duplicated. */
function mapMoods(raw) {
	const seen = [];
	for (const term of String(raw ?? '').split(',')) {
		const mapped = MOOD_MAP[term.trim().toLowerCase()];
		// "hopeful" and "inspiring" both land on Inspiring, and several books carry
		// both — the Set keeps the review from listing it twice.
		if (mapped && !seen.includes(mapped)) seen.push(mapped);
	}
	return seen;
}

/**
 * The read's date range, from "Dates Read" — "2025/03/27-2025/03/31", or a
 * single "2024/02/16" for a book read in a day. Returns null when the column is
 * empty, which the caller handles rather than inventing a range.
 */
function readDates(row) {
	const raw = String(row['Dates Read'] ?? '').trim();
	if (!raw) return null;
	const parts = raw.split('-').map((p) => p.trim()).filter(Boolean);
	const from = isoDay(parts[0]);
	const to = isoDay(parts[1] ?? parts[0]);
	if (!from || !to) return null;
	return to < from ? { from: to, to: from } : { from, to };
}

/** "2025/03/27" → "2025-03-27". */
function isoDay(v) {
	const m = String(v ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * A day as a timestamptz at local noon.
 *
 * Midnight UTC on "2025-03-27" is the 26th in America/New_York, which is the
 * zone every day boundary in this schema is measured in (migration 0020). Noon
 * lands on the intended day in any zone the site is ever read from.
 */
function stamp(v) {
	const day = isoDay(v) ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
	return day ? `${day}T12:00:00-05:00` : null;
}

/** The review column is a fragment of HTML. The stored value is plain text. */
function stripHtml(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	const text = s
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(?:div|p)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return text || null;
}

/** "Ken Liu (Translator), Maureen Freely (Translator)" → one element each. */
function splitContributors(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return [];
	// Split on commas that are not inside the role brackets.
	return s
		.split(/,(?![^(]*\))/)
		.map((p) => p.trim())
		.filter(Boolean);
}

function digits(raw) {
	const s = String(raw ?? '').replace(/[^0-9Xx]/g, '');
	return s.length >= 10 ? s.toUpperCase() : null;
}

/**
 * A title reduced to the part that identifies the book, so the same book logged
 * in two services matches: case, punctuation, a leading article and everything
 * after a colon all go. "The Martian: A Novel" and "The Martian" are one book.
 */
function titleKey(title) {
	return String(title ?? '')
		.toLowerCase()
		.split(':')[0]
		.replace(/^\s*(the|a|an)\s+/, '')
		.replace(/[^a-z0-9]+/g, '')
		.trim();
}

function pad(s, n) {
	return String(s).padEnd(n);
}

/** RFC 4180 enough for this file: quoted fields, doubled quotes, embedded commas. */
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;

	const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"') {
				if (src[i + 1] === '"') { field += '"'; i++; }
				else quoted = false;
			} else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') { row.push(field); field = ''; }
		else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
		else field += c;
	}
	if (field || row.length) { row.push(field); rows.push(row); }

	const header = rows.shift().map((h) => h.trim());
	return rows
		.filter((r) => r.some((v) => v.trim()))
		.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
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
