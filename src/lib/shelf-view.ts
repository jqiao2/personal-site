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
import { formatNumber, REFERENCE_SPINE_HEIGHT, spineWidth, type BookView } from './books-view';
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

/** FNV-1a. Any stable hash would do; this one is short and has no dependencies. */
function hash32(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** A stable number in [0,1) for one book and one purpose. */
function seed01(id: string, salt: string): number {
	return (hash32(`${id}~${salt}`) % 100000) / 100000;
}

/** Round to the nearest half pixel, matching the spine width scale. */
function half(px: number): number {
	return Math.round(px * 2) / 2;
}

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
 * The cloth a spine is bound in. Deep and aged rather than saturated: these sit
 * against #1a120a and have to hold gilt lettering.
 *
 * The mustard is the odd one out and carries a near-black foil — it is the only
 * family light enough that cream lettering on it would not read.
 */
const SPINE_FAMILIES = [
	{ h: 27, s: 32, l: 21, foil: '#efe1c2' }, // antique tobacco
	{ h: 152, s: 26, l: 15, foil: '#eee0c1' }, // deep forest
	{ h: 92, s: 19, l: 24, foil: '#efe3c6' }, // withered fern
	{ h: 355, s: 40, l: 20, foil: '#f2e4c6' }, // oxblood
	{ h: 43, s: 48, l: 36, foil: '#33240a' }, // dark mustard
	{ h: 189, s: 28, l: 19, foil: '#eadfc4' }, // silent-library teal
];

export interface SpineCloth {
	/** A left-to-right gradient: the spine is a curve, not a flat rectangle. */
	background: string;
	foil: string;
}

export function spineCloth(id: number | string): SpineCloth {
	const key = String(id);
	const family = SPINE_FAMILIES[hash32(`${key}~fam`) % SPINE_FAMILIES.length];
	// Jitter inside the family, so two books of the same colour standing next to
	// each other are still visibly two books.
	const hue = family.h + (seed01(key, 'hue') - 0.5) * 12;
	const sat = Math.max(10, family.s + (seed01(key, 'sat') - 0.5) * 7);
	const lit = family.l + (seed01(key, 'lit') - 0.5) * 7;
	const at = (d: number) =>
		`hsl(${hue.toFixed(1)} ${sat.toFixed(1)}% ${Math.max(8, lit + d).toFixed(1)}%)`;

	return {
		background:
			`linear-gradient(90deg,${at(7)} 0%,${at(3.5)} 15%,` +
			`${at(0)} 43%,${at(-4.5)} 79%,${at(-8.5)} 100%)`,
		foil: family.foil,
	};
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
}

/**
 * Type that fits the board it is printed on.
 *
 * Width picks the size, then one step down if the title would overrun the space
 * left after the author. Past that it truncates: a title set small enough to fit
 * in every case would be set too small to read in most of them.
 */
function spineType(width: number, height: number, title: string, author: string): SpineType {
	const showAuthor = width >= 21 && author.length > 0;
	const runLength = height - 36;

	let titleSize = width >= 42 ? 15 : width >= 34 ? 13.5 : width >= 26 ? 12.5 : width >= 21 ? 11 : 10;
	let authorSize = Math.max(7.5, half(titleSize - 3.5));

	const authorRun = showAuthor ? author.length * authorSize * 0.64 + 14 : 0;
	if (title.length * titleSize * 0.46 > runLength - authorRun - 6) {
		titleSize = Math.max(9, titleSize - 1.5);
		authorSize = Math.max(7.5, half(titleSize - 3.5));
	}

	return { titleSize, authorSize, showAuthor, runLength };
}

/** One spine, ready to render. Every field is a finished string or a number of px. */
export interface ShelfSpine {
	id: number;
	href: string;
	/** The main title — the subtitle is dropped, there is no room for it. */
	title: string;
	surname: string;
	showAuthor: boolean;
	/**
	 * False for a book read on paper, which gets a matte, unlettered binding. It
	 * is the only thing an unfoiled spine means: an unknown page count is drawn
	 * as an ordinary book rather than flagged.
	 */
	foiled: boolean;
	tooltip: string;
	/** The accessible name, since the spine's own lettering is a picture of text. */
	aria: string;
	width: number;
	height: number;
	cloth: string;
	foil: string;
	titleSize: number;
	authorSize: number;
	runLength: number;
}

interface SpineInput {
	id: number;
	/** The full title including any subtitle, for the tooltip. */
	fullTitle: string;
	main: string;
	author: string | null;
	pages: number | null;
	foiled: boolean;
	/** The last clause of the tooltip: how long it has waited, or when it was read. */
	tail: string;
}

function toShelfSpine(book: SpineInput): ShelfSpine {
	const height = spineHeight(book.id);
	// Drawn at the reference height the width scale is quoted at — NOT at this
	// book's own randomized height, which would give two books of equal length
	// different widths and break the one thing the width means.
	const width = spineWidth(book.pages, null, REFERENCE_SPINE_HEIGHT);

	const author = spineAuthor(book.author);
	const type = spineType(width, height, book.main, author);
	const cloth = spineCloth(book.id);

	const byline = book.author ? ` — ${book.author}` : '';
	const length = book.pages ? `${formatNumber(book.pages)} pages` : 'length unknown';

	return {
		id: book.id,
		href: `/books/${book.id}`,
		title: book.main,
		surname: author,
		showAuthor: type.showAuthor,
		foiled: book.foiled,
		tooltip: `${book.fullTitle}${byline} · ${length} · ${book.tail}`,
		aria: `${book.main}${byline}, ${length}`,
		width,
		height,
		cloth: cloth.background,
		// A paper book's lettering is not foil, so it does not take the family's
		// gold — it gets a flat cream that reads on every one of the six cloths.
		foil: book.foiled ? cloth.foil : '#efe6d2',
		titleSize: type.titleSize,
		authorSize: type.authorSize,
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
			foiled: true,
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
			foiled: b.tracked,
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
