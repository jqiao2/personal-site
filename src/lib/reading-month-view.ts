// The "Month in reading" share card, as pure functions — the book log's answer
// to the film card, and its sibling in every way that isn't listed here.
//
// What is its own:
//   - a day holds the books you turned pages in, so one book fills a fortnight
//     of cells rather than appearing once;
//   - the book you read most of that day is on top, EXCEPT that a book you
//     finished that day goes on top however few pages it took to get there;
//   - a finish is marked, and never says whether it was set by hand or inferred;
//   - the summary only appears on the tall aspect, and the grid takes the room
//     back on the other two.
//
// The calendar arithmetic and the artboard come from share-card.ts.

import { siteDay } from './day';
import { FINISHED_PROGRESS } from './books-view';
import {
	ASPECTS,
	daysInMonth,
	firstWeekdayIndex,
	geometry as cardGeometry,
	longestStreak,
	monthQuery as cardQuery,
	parseMonthKey,
	weekRows,
	type Aspect,
	type Geometry,
} from './share-card';

export {
	ASPECTS,
	CARD_WIDTH,
	MONTH_ABBR,
	WEEKDAYS,
	aspectBySlug,
	monthKey,
	monthLabel,
	monthOf,
	parseMonthKey,
	shiftMonth,
	weekRows,
	type Aspect,
} from './share-card';

/** One row of `book_days`: a book, a local calendar day, and what it took. */
export interface ReadingDay {
	book_id: number;
	day: string;
	pages: number;
	seconds: number;
}

/** A book as the card needs it. Everything else about it stays on the server. */
export interface MonthBook {
	id: number;
	title: string;
	authors: string | null;
	cover_url: string | null;
	total_pages: number | null;
	furthest_page: number;
	finished_at: string | null;
	is_public: boolean;
	/** The last day this book was read on, across all months. */
	last_day: string | null;
}

/**
 * Whether a book counts as read to the end.
 *
 * Nothing in the tracker writes `finished_at` except the owner and the
 * StoryGraph import, so progress stands in for it — the same threshold the
 * shelves use, for the same reason (the last pages of an EPUB are the
 * acknowledgements). The card never distinguishes the two: a finish is a finish.
 */
export function isFinished(book: MonthBook): boolean {
	if (book.finished_at) return true;
	if (!book.total_pages) return false;
	return book.furthest_page / book.total_pages >= FINISHED_PROGRESS;
}

/**
 * The day a finish belongs on: the date it was marked, else the last day the
 * book was touched. Null for a book that isn't finished.
 *
 * `finished_at` is an instant, and a day here is a calendar day in the site's
 * zone — the same zone `book_days` buckets sessions into, so the two line up.
 */
export function finishDay(book: MonthBook): string | null {
	if (!isFinished(book)) return null;
	if (book.finished_at) return siteDay(book.finished_at);
	return book.last_day;
}

export const COVER_SIZES = { top: 'M', behind: 'S' } as const;

/**
 * A cover at the size it will be drawn.
 *
 * Open Library bakes the size into the URL — `-S`, `-M` (~180px), `-L` (~500px)
 * — and what's on the row is whichever the importer happened to ask for, so the
 * suffix is swapped rather than trusted. A cell is 95–133px on the artboard, so
 * `-M` is the top of a stack; a print behind one shows a few pixels of margin
 * and takes `-S`.
 */
export function coverUrl(book: MonthBook, size: 'S' | 'M' | 'L'): string | null {
	if (!book.cover_url || !book.is_public) return null;
	return book.cover_url.replace(/-(S|M|L)\.jpg$/i, `-${size}.jpg`);
}

/** A book in a day's stack. `layer` 0 is the top; 1+ peek out behind it. */
export interface ReadingPrint {
	bookId: number;
	/** Empty for a private book — it holds its place and says nothing else. */
	title: string;
	authors: string;
	cover: string | null;
	/** Read privately: no cover, no title, but still a print and still counted. */
	private: boolean;
	/** Finished ON THIS DAY — the gilt edge and the seal. */
	finished: boolean;
	pages: number;
	layer: number;
	/** Degrees this print is rotated by; alternates so a stack looks hand-set. */
	rotation: number;
}

export interface ReadingCell {
	/** A padding cell before the 1st or after the last — drawn as nothing. */
	outside: boolean;
	date: number;
	/** The day's books, top of the stack first. */
	prints: ReadingPrint[];
	/** Prints drawn behind the top one, deepest first. Capped at LAYERS. */
	behind: ReadingPrint[];
	count: number;
	/** How deep the stack reads in its shadow — capped, like `behind`. */
	depth: number;
	/** Every book that day, for the hover tooltip. */
	lines: { text: string; finished: boolean }[];
}

/** How many prints peek out behind the top one. Deeper stacks just cast more shadow. */
const LAYERS = 3;

/**
 * A day's reading in stack order.
 *
 * A book finished that day comes first however little of it was read — finishing
 * is the event of the day, and the card is about finishing. Everything else goes
 * by pages, then by time, then by id so two identical days can't shuffle.
 */
export function sortDayReading(rows: ReadingDay[], finished: Map<number, string>): ReadingDay[] {
	return rows.slice().sort((a, b) => {
		const aDone = finished.get(a.book_id) === a.day ? 1 : 0;
		const bDone = finished.get(b.book_id) === b.day ? 1 : 0;
		if (aDone !== bDone) return bDone - aDone;
		if (a.pages !== b.pages) return b.pages - a.pages;
		if (a.seconds !== b.seconds) return b.seconds - a.seconds;
		return a.book_id - b.book_id;
	});
}

function toPrint(
	row: ReadingDay,
	book: MonthBook,
	layer: number,
	finished: boolean,
): ReadingPrint {
	return {
		bookId: book.id,
		title: book.is_public ? book.title : '',
		authors: book.is_public ? (book.authors ?? '') : '',
		cover: coverUrl(book, layer === 0 ? COVER_SIZES.top : COVER_SIZES.behind),
		private: !book.is_public,
		finished,
		pages: row.pages,
		layer,
		rotation: layer % 2 ? 1.6 : -1.8,
	};
}

/** The month's cells, in reading order, padded out to whole weeks. */
export function buildCells(
	key: string,
	rows: ReadingDay[],
	books: Map<number, MonthBook>,
	finished: Map<number, string>,
): ReadingCell[] {
	const parsed = parseMonthKey(key);
	if (!parsed) return [];
	const { year, month } = parsed;
	const days = daysInMonth(year, month);
	const first = firstWeekdayIndex(year, month);

	const byDay = new Map<number, ReadingDay[]>();
	for (const row of rows) {
		const date = Number(row.day.slice(8, 10));
		const list = byDay.get(date);
		if (list) list.push(row);
		else byDay.set(date, [row]);
	}

	const cells: ReadingCell[] = [];
	for (let i = 0; i < weekRows(key) * 7; i++) {
		const date = i - first + 1;
		if (date < 1 || date > days) {
			cells.push({ outside: true, date: 0, prints: [], behind: [], count: 0, depth: 0, lines: [] });
			continue;
		}
		const day = sortDayReading(byDay.get(date) ?? [], finished);
		const prints: ReadingPrint[] = [];
		const lines: ReadingCell['lines'] = [];
		day.forEach((row, layer) => {
			const book = books.get(row.book_id);
			if (!book) return;
			const done = finished.get(row.book_id) === row.day;
			prints.push(toPrint(row, book, layer, done));
			const who = book.is_public ? `${book.title}${book.authors ? ` — ${book.authors}` : ''}` : 'Private book';
			lines.push({
				text: `${done ? '✓ ' : ''}${who} · ${row.pages} ${row.pages === 1 ? 'page' : 'pages'}`,
				finished: done,
			});
		});
		cells.push({
			outside: false,
			date,
			prints,
			// Deepest first so the DOM paints them in the order they overlap.
			behind: prints.slice(1, LAYERS + 1).reverse(),
			count: prints.length,
			depth: Math.min(LAYERS, Math.max(0, prints.length - 1)),
			lines,
		});
	}
	return cells;
}

/**
 * Vertical space the chrome takes.
 *
 * Feed and Square drop the summary — four figures under a five-row grid leaves
 * the prints too small to see a cover in — so the grid takes that band back and
 * only the tall aspect carries the numbers.
 */
const CHROME_WITH_FIGURES = 470;
const CHROME_BARE = 330;

export interface ReadingGeometry extends Geometry {
	/** Whether the summary is drawn at this aspect. */
	figures: boolean;
}

export function hasFigures(aspect: Aspect): boolean {
	return aspect.id === '9:16';
}

/** Geometry for every aspect, keyed by id — the aspect toggle just swaps these in. */
export function geometries(rows: number): Record<string, ReadingGeometry> {
	const out: Record<string, ReadingGeometry> = {};
	for (const aspect of ASPECTS) {
		const figures = hasFigures(aspect);
		out[aspect.id] = {
			...cardGeometry(rows, aspect.height, figures ? CHROME_WITH_FIGURES : CHROME_BARE),
			figures,
		};
	}
	return out;
}

/** The reading card's settings in a query string. Only the aspect, for now. */
export function monthQuery(aspect: Aspect): string {
	return cardQuery(aspect);
}

export interface Figure {
	label: string;
	value: string;
}

/**
 * The four figures under the grid.
 *
 * **Books** counts distinct books, so a book read across nineteen days is one
 * book though it holds nineteen cells above. **Streak** is measured inside this
 * month only. **Finished** counts books whose finish lands in the month — which
 * includes one finished by hand with no page turns behind it, so the number can
 * exceed what the grid appears to show.
 */
export function summarise(key: string, rows: ReadingDay[], finishedInMonth: number): Figure[] {
	const books = new Set(rows.map((r) => r.book_id));
	const pages = rows.reduce((total, r) => total + r.pages, 0);
	const streak = longestStreak(
		key,
		rows.map((r) => r.day),
	);
	return [
		{ label: 'Books', value: String(books.size) },
		{ label: 'Pages', value: pages.toLocaleString('en-US') },
		{ label: 'Streak', value: `${streak} ${streak === 1 ? 'day' : 'days'}` },
		{ label: 'Finished', value: String(finishedInMonth) },
	];
}
