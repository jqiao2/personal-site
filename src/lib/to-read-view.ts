// Presentation layer for /books/to-read, the same shape as books-view.ts:
// arithmetic and strings, no database, no async.
//
// The pile is the one page in the book log with nothing measured on it.
// Every book here has zero sessions by definition, so there is no progress, no
// pace and no percentage — the fields below are a title, a date, and how long
// the book has been waiting.
import type { BookProgress, PileBook } from './books-queries';
import {
	daysBetween,
	formatDay,
	formatNumber,
	SPINE_HEIGHT,
	spineWidth,
	splitTitle,
	today,
	zonedDay,
} from './books-view';

/** Shorter than the shelf's spine: these are a list, not an illustration. */
export const PILE_SPINE_HEIGHT = 84;

/**
 * The shelf's own scale, so the same book is the same object on both pages —
 * imported rather than reimplemented, because two spine widths that agree by
 * coincidence stop agreeing the first time one is tuned.
 *
 * A book with no page count at all has no width to draw and gets the narrow
 * dashed outline instead, which is the vocabulary the book page already uses for
 * something it does not know.
 */
function pileSpineWidth(book: PileBook): number {
	if (!book.total_pages && !book.ol_pages) return 13;
	return spineWidth(book.total_pages, book.ol_pages);
}

/**
 * How long it has been waiting. Exact days for the first six months, then
 * months, then years: past a point the length of the wait is the whole content
 * of the number and "473 days ago" makes you do the division yourself.
 */
function ageLabel(days: number): string {
	if (days >= 365) {
		const years = Math.floor(days / 365);
		return `${years} year${years === 1 ? '' : 's'} on the pile`;
	}
	if (days >= 180) return `${Math.round(days / 30.4)} months on the pile`;
	if (days <= 0) return 'added today';
	if (days === 1) return 'yesterday';
	return `${days} days ago`;
}

export interface PileView {
	id: number;
	main: string;
	sub: string | null;
	author: string | null;
	href: string;
	isPrivate: boolean;
	spineWidth: number;
	/** False when the book has no page count: the spine is drawn as an outline. */
	hasSpine: boolean;
	spineTitle: string;
	/** "2005 · Nonfiction · 209 pages", or "Typed in" when none of that is known. */
	meta: string;
	/** True when `meta` is the placeholder rather than facts about the edition. */
	metaIsPlaceholder: boolean;
	addedLabel: string;
	ageLabel: string;
	/**
	 * The stored timestamp, not a display string. The page hands it back when a
	 * removal is undone: taking a book off the pile nulls `added_at`, and putting
	 * it back with `now` would quietly relabel a book added in June as added
	 * today — and move it to the top of a list sorted by that.
	 */
	addedAt: string;
	/** Sort and filter keys, rendered as data attributes for the client. */
	sortAdded: string;
	sortAuthor: string;
	sortPages: number;
	sortKind: number;
	filterText: string;
}

export function toPileView(book: PileBook, todayDay = today()): PileView {
	const { main, sub } = splitTitle(book.title);
	const addedDay = zonedDay(book.added_at);

	// What is known about the edition, in the order it reads. A hand-typed book
	// has none of it, and says so rather than printing an empty row of separators.
	const bits = [
		book.first_published,
		book.kind,
		book.ol_pages ?? book.total_pages
			? `${formatNumber((book.ol_pages ?? book.total_pages)!)} pages`
			: null,
	].filter(Boolean) as string[];

	const author = book.authors;
	// Surname, for the author sort. Everything here is "Firstname Lastname" or a
	// list joined with " & ", so the last word of the first name is close enough
	// and never worse than sorting by first name.
	const surname = (author ?? '').split(' & ')[0].split(' ').pop() ?? '';

	return {
		id: book.id,
		main,
		sub,
		author,
		href: `/books/${book.id}`,
		isPrivate: !book.is_public,
		spineWidth: pileSpineWidth(book),
		hasSpine: book.total_pages !== null || book.ol_pages !== null,
		spineTitle: book.ol_pages ?? book.total_pages
			? `${formatNumber((book.ol_pages ?? book.total_pages)!)} pages, none read`
			: 'Length unknown',
		meta: bits.length ? bits.join(' · ') : 'Typed in',
		metaIsPlaceholder: bits.length === 0,
		addedLabel: formatDay(addedDay),
		ageLabel: ageLabel(daysBetween(addedDay, todayDay)),
		addedAt: book.added_at,
		sortAdded: addedDay,
		sortAuthor: surname.toLowerCase(),
		// Unknown length sorts last rather than as zero, which would put every
		// hand-typed book at the short end of a list about length.
		sortPages: book.ol_pages ?? book.total_pages ?? -1,
		sortKind: book.kind === 'Fiction' ? 0 : book.kind === 'Nonfiction' ? 1 : 2,
		filterText: `${book.title} ${author ?? ''}`.toLowerCase(),
	};
}

export function buildPile(books: PileBook[], todayDay = today()): PileView[] {
	return books.map((b) => toPileView(b, todayDay));
}

/**
 * The strip of spines the shelf page shows above the link to this one. Newest
 * first, and only a few — it is a pointer, not a preview of the whole pile.
 */
export function pileStrip(books: PileBook[], limit = 4) {
	return books.slice(0, limit).map((b) => ({
		id: b.id,
		href: `/books/${b.id}`,
		// The printed length, matching the width the spine is drawn at. Quoting
		// KOReader's count beside a spine scaled to the edition's would explain the
		// picture with the wrong number.
		title: `${b.title}${b.authors ? ` — ${b.authors}` : ''}${b.ol_pages ?? b.total_pages ? ` · ${formatNumber((b.ol_pages ?? b.total_pages)!)} pages` : ''}`,
		width: pileSpineWidth(b),
		hasSpine: b.total_pages !== null || b.ol_pages !== null,
	}));
}

/**
 * Titles compared the way a person would: case, punctuation, spacing and a
 * leading article all discarded. KOReader's title for a sideloaded file is
 * derived from the filename ("Piranesi - Susanna Clarke", "Martian_ A Novel,
 * The"), so this has to survive a fair amount of mangling.
 */
function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/^(the|a|an) /, '')
		.trim();
}

/** How much of a title has to match before the page is willing to ask. */
const MIN_TITLE_OVERLAP = 8;

function looksLikeSameBook(pileTitle: string, candidate: string): boolean {
	const a = normalizeTitle(pileTitle);
	const b = normalizeTitle(candidate);
	if (!a || !b) return false;
	if (a === b) return true;
	// Containment rather than equality: the candidate is usually the pile title
	// plus an author, a series or an edition. Short titles are excluded because
	// "Orbital" appears inside plenty of unrelated filenames.
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return shorter.length >= MIN_TITLE_OVERLAP && longer.includes(shorter);
}

export interface MergeSuggestion {
	/** The row the Kindle created, which is the one that gets folded in. */
	sourceId: number;
	/** What KOReader calls the file — the recognisable half of the sentence. */
	sourceTitle: string;
	line: string;
}

/** A synced book is only worth asking about while it is still newly started. */
const SUGGEST_WITHIN_DAYS = 30;

/**
 * Pile entries that a freshly synced book appears to be a second copy of.
 *
 * This is the repair for the one thing the automatic transition cannot do on its
 * own: a hand-typed pile entry has no md5, so the sync files the same book under
 * a new row instead of filling this one in. Matching is on the title alone and
 * is deliberately never acted on — it produces a question on the page, and the
 * merge only happens if the answer is yes.
 *
 * Keyed by pile book id. A pile book with two plausible candidates gets neither:
 * an ambiguous guess is worse than no guess when the yes button is destructive.
 */
export function suggestMerges(
	pile: PileBook[],
	candidates: BookProgress[],
	todayDay = today(),
): Map<number, MergeSuggestion> {
	const fresh = candidates.filter(
		(c) => c.md5 && daysBetween(zonedDay(c.first_read_at), todayDay) <= SUGGEST_WITHIN_DAYS,
	);
	const out = new Map<number, MergeSuggestion>();

	for (const book of pile) {
		// A pile entry with an md5 of its own is already the row the sync writes to.
		if (book.md5) continue;

		const hits = fresh.filter(
			(c) => looksLikeSameBook(book.title, c.title) || looksLikeSameBook(book.title, c.source_title),
		);
		if (hits.length !== 1) continue;

		const hit = hits[0];
		out.set(book.id, {
			sourceId: hit.id,
			sourceTitle: hit.source_title,
			line: `The Kindle started sending pages for ${hit.source_title} on ${formatDay(zonedDay(hit.first_read_at))}. Is that this?`,
		});
	}

	return out;
}

/** Height of the ghost spine left behind by a resolved row. */
export const GHOST_SPINE_HEIGHT = Math.round(SPINE_HEIGHT / 3);
