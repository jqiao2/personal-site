// Presentation layer for the two bookshelves at the foot of /books: the to-read
// pile and everything finished, each drawn as a row of hardcover spines.
//
// Same contract as books-view.ts and to-read-view.ts — arithmetic and strings,
// no database, no async. Every number the shelf needs is settled here so the
// .astro file stays markup.
//
// The shelves replaced two lists: a four-spine strip pointing at /books/to-read,
// and a detailed row per finished book with its read time and finish date. Those
// facts now live on each book's own page and in the spine's tooltip.
import {
	bookCloth,
	formatNumber,
	half,
	REFERENCE_SPINE_HEIGHT,
	seed01,
	spineWidth,
	type BookView,
} from './books-view';
import type { PileView } from './to-read-view';

/**
 * How tall a spine can be. Real books on a real shelf are not one height, and
 * the unevenness along the top is most of what makes the row read as a shelf
 * rather than a bar chart — but the range stays narrow enough that nothing looks
 * like a different kind of object.
 */
const SPINE_MIN_HEIGHT = 155;
const SPINE_MAX_HEIGHT = 205;

/** Interior height of the shelf, clearing the tallest spine with headroom. */
export const SHELF_HEIGHT = 236;

/**
 * Room above the shelf for a pulled book to rise into. The scroller clips
 * vertically — without this the top of a pulled spine would be cut off.
 */
export const SHELF_PULL_HEADROOM = 54;

/**
 * A book's height on the shelf.
 *
 * Seeded from the id rather than drawn at random, so a book is the same height
 * on every reload and on both shelves — a book that changed size when you moved
 * it from the pile to the finished shelf would be a different book. Height
 * deliberately carries no meaning: length is already the width's job, and a
 * second encoding of it would just make the shelf a chart drawn twice.
 */
export function spineHeight(id: number | string): number {
	const t = seed01(String(id), 'h');
	return Math.round(SPINE_MIN_HEIGHT + t * (SPINE_MAX_HEIGHT - SPINE_MIN_HEIGHT));
}

/**
 * Surnames that are two words. Not exhaustive and never will be — it covers the
 * particles common enough to be worth catching, and anything it misses prints
 * the last word, which is wrong in the same way a library catalogue is wrong.
 */
const PARTICLE = /^(le|la|de|del|della|da|van|von|du|den|der|ten|ter|di|st\.?|bin|ibn|mac|mc|o')$/i;

function surname(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length === 1) return parts[0];
	const last = parts[parts.length - 1];
	const previous = parts[parts.length - 2];
	return PARTICLE.test(previous) ? `${previous} ${last}` : last;
}

/**
 * What goes on the spine where the author's name goes. Surnames only — a spine
 * is a few characters wide and "Ursula K. Le Guin" is not one of them.
 */
export function spineAuthor(authors: string | null): string {
	const names = (authors ?? '').split(/\s*&\s*|\s*,\s*/).filter(Boolean);
	if (!names.length) return '';
	if (names.length === 1) return surname(names[0]);
	if (names.length === 2) return `${surname(names[0])} & ${surname(names[1])}`;
	return `${surname(names[0])} et al.`;
}

interface SpineType {
	titleSize: number;
	authorSize: number;
	showAuthor: boolean;
	/** Length of the rotated text run, i.e. the spine's height less its bands. */
	runLength: number;
	/** How many lines the title may break across before it truncates. */
	titleLines: number;
}

/** Space across the spine for one line of title, with a little air around it. */
const LINE_PITCH = 1.25;
/** Past three, a spine has stopped being lettered and is carrying a paragraph. */
const MAX_TITLE_LINES = 3;

/** How many lines of a given size fit across a spine of a given width. */
function fitLines(width: number, size: number): number {
	return Math.max(1, Math.min(MAX_TITLE_LINES, Math.floor(width / (size * LINE_PITCH))));
}

/**
 * Type that fits the board it is printed on.
 *
 * Width picks the size and, with it, how many lines the title can break across:
 * a thick spine is lettered across two or three lines the way a real one is,
 * while a thin one gets a single line and then an ellipsis. Only if the title
 * overruns even that does the size step down once. A size small enough to fit
 * every title in one line would be too small to read on most of them.
 */
function spineType(width: number, height: number, title: string, author: string): SpineType {
	const showAuthor = width >= 21 && author.length > 0;
	const runLength = height - 36;

	let titleSize = width >= 42 ? 15 : width >= 34 ? 13.5 : width >= 26 ? 12.5 : width >= 21 ? 11 : 10;
	let authorSize = Math.max(7.5, half(titleSize - 3.5));

	const authorRun = showAuthor ? author.length * authorSize * 0.64 + 14 : 0;
	const run = runLength - authorRun - 6;

	let titleLines = fitLines(width, titleSize);
	if (title.length * titleSize * 0.46 > run * titleLines) {
		titleSize = Math.max(9, titleSize - 1.5);
		authorSize = Math.max(7.5, half(titleSize - 3.5));
		// Smaller type may buy back a line on a spine that was one short of it.
		titleLines = fitLines(width, titleSize);
	}

	return { titleSize, authorSize, showAuthor, runLength, titleLines };
}

/**
 * What a series or edition note adds in parentheses — "(Dune Chronicles, #1)",
 * "(Penguin Classics)" — is catalogue apparatus rather than the book's name, and
 * on a spine it crowds out the name itself. The tooltip keeps the whole title.
 */
function stripParentheticals(title: string): string {
	// Innermost pairs first, repeatedly: one pass over a nested parenthetical
	// would leave the outer pair behind as an empty "()".
	let stripped = title;
	for (;;) {
		const next = stripped.replace(/\s*\([^()]*\)/g, '');
		if (next === stripped) break;
		stripped = next;
	}
	stripped = stripped.replace(/\s{2,}/g, ' ').trim();
	// A title that is nothing but a parenthetical keeps what it had.
	return stripped || title;
}

/** One spine, ready to render. Every field is a finished string or a number of px. */
export interface ShelfSpine {
	id: number;
	href: string;
	/** The main title — the subtitle and any parentheses are dropped, no room. */
	title: string;
	surname: string;
	showAuthor: boolean;
	tooltip: string;
	/** The accessible name, since the spine's own lettering is a picture of text. */
	aria: string;
	width: number;
	height: number;
	cloth: string;
	foil: string;
	titleSize: number;
	authorSize: number;
	titleLines: number;
	runLength: number;
}

interface SpineInput {
	id: number;
	/** The full title including any subtitle, for the tooltip. */
	fullTitle: string;
	main: string;
	author: string | null;
	pages: number | null;
	/** The last clause of the tooltip: how long it has waited, or when it was read. */
	tail: string;
}

function toShelfSpine(book: SpineInput): ShelfSpine {
	const height = spineHeight(book.id);
	// Drawn at the reference height the width scale is quoted at — NOT at this
	// book's own randomized height, which would give two books of equal length
	// different widths and break the one thing the width means.
	const width = spineWidth(book.pages, null, REFERENCE_SPINE_HEIGHT);

	const printed = stripParentheticals(book.main);
	const author = spineAuthor(book.author);
	const type = spineType(width, height, printed, author);
	const cloth = bookCloth(book.id);

	const byline = book.author ? ` — ${book.author}` : '';
	const length = book.pages ? `${formatNumber(book.pages)} pages` : 'length unknown';

	return {
		id: book.id,
		href: `/books/${book.id}`,
		title: printed,
		surname: author,
		showAuthor: type.showAuthor,
		tooltip: `${book.fullTitle}${byline} · ${length} · ${book.tail}`,
		aria: `${printed}${byline}, ${length}`,
		width,
		height,
		cloth: cloth.background,
		foil: cloth.foil,
		titleSize: type.titleSize,
		authorSize: type.authorSize,
		titleLines: type.titleLines,
		runLength: type.runLength,
	};
}

function fullTitle(main: string, sub: string | null): string {
	return sub ? `${main}: ${sub}` : main;
}

/** The pile, newest addition at the left. Nothing here has been read. */
export function toReadShelf(pile: PileView[]): ShelfSpine[] {
	return pile.map((b) =>
		toShelfSpine({
			id: b.id,
			fullTitle: fullTitle(b.main, b.sub),
			main: b.main,
			author: b.author,
			pages: b.pages,
			tail: b.ageLabel,
		}),
	);
}

/** Everything read, newest finish at the left. */
export function finishedShelf(finished: BookView[]): ShelfSpine[] {
	return finished.map((b) =>
		toShelfSpine({
			id: b.id,
			fullTitle: fullTitle(b.main, b.sub),
			main: b.main,
			author: b.author,
			pages: b.pages,
			tail: `finished ${b.finishedDate}`,
		}),
	);
}

/** "30 books · 2024 → 2026" — the caption beside the Finished heading. */
export function shelfSpan(finished: BookView[]): string {
	if (!finished.length) return '';
	const count = `${finished.length} book${finished.length === 1 ? '' : 's'}`;
	const years = finished.map((b) => b.finishedYear);
	const from = Math.min(...years);
	const to = Math.max(...years);
	return from === to ? `${count} · ${from}` : `${count} · ${from} → ${to}`;
}
