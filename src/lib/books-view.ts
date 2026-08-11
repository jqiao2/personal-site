// Presentation layer for /books: turns the aggregates in books-queries.ts
// into the strings, sizes and grids the page renders.
//
// Nothing here touches the database, and nothing here is async — it is all
// arithmetic on days and page counts, kept out of the .astro so the page is
// markup and this is the reasoning.
//
// DAYS ARE STRINGS. Every day boundary in the reading data is a local calendar
// day in READING_TZ (migration 0020 buckets sessions that way), so a day here is
// always "YYYY-MM-DD" and never a Date. Where arithmetic is needed the string is
// parsed to UTC midnight, so a DST boundary can never add or drop an hour
// mid-subtraction the way local-midnight Dates would.
import { SITE_TZ, siteDay } from './day';
import {
	CURRENTLY_READING_DAYS,
	type BookProgress,
	type HeatmapDay,
	type ManualRead,
	type OfflineRead,
} from './books-queries';

/**
 * The zone the stored day boundaries are measured in. Must match migration 0020,
 * which is why this one stays fixed rather than following the reader's clock the
 * way the film composer's date does: a day here has to name the same bucket the
 * SQL side already wrote.
 */
export const READING_TZ = SITE_TZ;

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local day an instant falls on, e.g. a `last_read_at` timestamptz. */
export function zonedDay(when: string | Date): string {
	return siteDay(when);
}

/** Today, in the reading timezone. */
export function today(): string {
	return siteDay();
}

function dayMs(day: string): number {
	const [y, m, d] = day.split('-').map(Number);
	return Date.UTC(y, m - 1, d);
}

function msDay(ms: number): string {
	const d = new Date(ms);
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
	return Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
}

export function addDays(day: string, n: number): string {
	return msDay(dayMs(day) + n * DAY_MS);
}

export function formatNumber(n: number): string {
	return n.toLocaleString('en-US');
}

/** Seconds as reading time: "41m" under an hour, "4h 41m" over. */
export function formatDuration(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "2025-04-13" → "13 Apr 2025". */
export function formatDay(day: string): string {
	const [y, m, d] = day.split('-').map(Number);
	return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2025-04-13" → "Apr 2025". */
export function formatMonth(day: string): string {
	const [y, m] = day.split('-').map(Number);
	return `${MONTHS[m - 1]} ${y}`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * "The Martian: A Novel" → main "The Martian", sub "A Novel".
 *
 * Subtitles are set smaller and in italic rather than dropped: they are often
 * the only thing distinguishing two editions, but they wreck a heading's rhythm
 * when run inline.
 */
export function splitTitle(title: string): { main: string; sub: string | null } {
	const at = title.indexOf(': ');
	if (at <= 0) return { main: title, sub: null };
	return { main: title.slice(0, at), sub: title.slice(at + 2) };
}

/** Height of a book spine in the shelf illustrations, in px. */
export const SPINE_HEIGHT = 104;

/**
 * The height the width scale below is expressed at: the mid-height of a spine on
 * the /books shelves, which are the largest and most detailed drawing of a book
 * on the site. Every smaller context scales off it rather than defining its own
 * widths, so a given book keeps its shape wherever it appears.
 */
export const REFERENCE_SPINE_HEIGHT = 180;

/** Covers, boards and endpapers — a book has width before it has any pages. */
const SPINE_BOARDS = 16;
/** Width per page, at REFERENCE_SPINE_HEIGHT. */
const SPINE_PER_PAGE = 0.05;
/** Reached around 960 pages; the few books past it are all "very long" alike. */
const MAX_SPINE = 64;
/** Below this a scaled-down spine stops reading as a book and becomes a rule. */
const MIN_DRAWN_SPINE = 8;

/**
 * An ordinary book, drawn wherever the real length is unknown.
 *
 * A book with no page count is still a book of some size, and the honest guess
 * is the unremarkable one. The alternative — a hairline, or a dashed outline —
 * spends the most conspicuous spine on the shelf advertising a gap in the
 * metadata, which is the least interesting thing about that book.
 */
const DEFAULT_PAGES = 250;

/**
 * Spine width from page count, linear, at a given drawn height.
 *
 * Linear rather than the square root this used to use. The compressed scale was
 * tuned for an 11px spine standing beside a row of text, where the long books
 * would otherwise have run away with the row. At shelf size that reasoning
 * inverts: sqrt packs every 150–450 page book — which is most of a library —
 * into a few pixels of each other, so the shelf shows one repeated width and
 * says nothing. Linear spreads exactly the range the collection actually
 * occupies, and the cap handles the doorstops.
 *
 * WHICH page count matters. `ol_pages` is the printed edition's; `total_pages`
 * is KOReader's repagination of the file, which runs about three times higher
 * and shifts with the font size on the device. Mixing them puts two scales in
 * one picture, so the printed length wins wherever it is known — migration 0026.
 *
 * `height` is the CONTEXT's height, not an individual book's. The shelves draw
 * books at randomized heights; passing those in would give two books of equal
 * length different widths and break the one thing the width is supposed to mean.
 */
export function spineWidth(
	pages: number | null,
	editionPages: number | null = null,
	height: number = SPINE_HEIGHT,
): number {
	const known = editionPages ?? pages ?? 0;
	const length = known > 0 ? known : DEFAULT_PAGES;
	const width = Math.min(MAX_SPINE, SPINE_BOARDS + length * SPINE_PER_PAGE);
	const drawn = Math.max(MIN_DRAWN_SPINE, (width * height) / REFERENCE_SPINE_HEIGHT);
	// Half-pixel steps rather than whole ones. At the small end of the scale a
	// whole-pixel round quantises away most of the difference the linear scale was
	// adopted to show — 90 pages and 150 pages would come out the same width.
	return Math.round(drawn * 2) / 2;
}

export interface BookFact {
	k: string;
	v: string;
}

/** One book, ready to render. Every field is a finished string or a number of px. */
export interface BookView {
	id: number;
	/** True once the book is done — see buildShelf for what counts. */
	done: boolean;
	/**
	 * Whether there are recorded reading sessions behind this book. False for the
	 * older entries, whose every page-derived field below is a placeholder rather
	 * than a measurement — the page leaves those empty rather than printing a
	 * plausible zero.
	 */
	tracked: boolean;
	main: string;
	sub: string | null;
	author: string | null;
	/** 0–1, or null when the book's page count is unknown. */
	progress: number | null;
	/**
	 * The printed length the spine is drawn from — `ol_pages` where it is known,
	 * KOReader's count otherwise, null when neither is. Carried alongside the
	 * pre-computed `spineWidth` because the shelves draw the same book at a
	 * different height and have to run the width formula again themselves.
	 */
	pages: number | null;
	/**
	 * The jacket, where the book has been matched to an edition that has one.
	 * Null leaves the spine to stand in — see BookThumb.
	 */
	coverUrl: string | null;
	spineWidth: number;
	spineFill: number;
	/** "627 / 628", or "page 106" when there is no total to divide by. */
	pagesLabel: string;
	/** "99.8%", or null when progress is unknown. */
	percent: string | null;
	facts: BookFact[];
	/**
	 * Set only for a book in flight that the sync knows nothing about, where it
	 * replaces the progress bar. Null everywhere else — a tracked book's progress
	 * is drawn, not described.
	 */
	untrackedNote: string | null;
	readTime: string;
	firstDay: string;
	lastDay: string;
	daysAgo: number;
	finishedDate: string;
	finishedYear: number;
	finishedMeta: string;
	asideMeta: string;
}

/**
 * How far through a book counts as having read it.
 *
 * `books.finished_at` is the authoritative answer, but nothing sets it — the
 * sync endpoint deliberately never touches the owner's columns, and there is no
 * UI for it yet. Going by that column alone, a book you read to the last page
 * stays "set aside" forever and the finished shelf is permanently empty.
 *
 * So progress stands in for it. The threshold is short of 100% because the last
 * pages of an EPUB are the acknowledgements and the index, which people stop
 * before; KOReader's repagination also means the recorded final page is only
 * approximately the real one. A book marked finished by hand still wins, whatever
 * its progress.
 */
export const FINISHED_PROGRESS = 0.97;

// The day minimum itself lives only in SQL, in `reading_day_min_pages()` from
// migration 0028. There was a copy of the number here so the shelves could
// explain themselves in a footnote; the footnote is gone, and a second copy of a
// threshold that nothing reads is just something else to keep in step.

/**
 * Percentages carry a decimal at the ends of the range and none in the middle:
 * "99.8%" and "0.4%" are the interesting cases, and "47.3%" is noise.
 */
function formatPercent(progress: number): string {
	const pct = progress * 100;
	if (pct >= 99.995) return '100%';
	if (pct < 10 || pct > 99) return `${pct.toFixed(1)}%`;
	return `${Math.round(pct)}%`;
}

export function toBookView(book: BookProgress, todayDay = today()): BookView {
	const { main, sub } = splitTitle(book.title);
	const total = book.total_pages;
	const furthest = Number(book.furthest_page);
	const distinct = Number(book.distinct_pages_read);
	const seconds = Number(book.seconds_read);
	const daysRead = Number(book.days_read);

	const progress = total ? Math.min(1, furthest / total) : null;
	const firstDay = zonedDay(book.first_read_at);
	const lastDay = zonedDay(book.last_read_at);
	const daysAgo = daysBetween(lastDay, todayDay);

	// A pace drawn from a couple of minutes of reading is a random number, so
	// under four minutes the page declines to quote one rather than promising
	// "1,400 pages/hr" off one fast page turn.
	const pagesPerHour = seconds > 240 ? distinct / (seconds / 3600) : null;
	const hoursLeft = pagesPerHour && total ? (total - furthest) / pagesPerHour : null;

	const lastPickedUp =
		daysAgo <= 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;

	const facts: BookFact[] = [
		{ k: 'Last picked up', v: lastPickedUp },
		{ k: 'Time on it', v: formatDuration(seconds) },
		{ k: 'Sessions', v: plural(daysRead, 'day') },
		{ k: 'Pace', v: pagesPerHour ? `${Math.round(pagesPerHour)} pages/hr` : 'too early to say' },
		{
			k: 'Left at that pace',
			v: hoursLeft && hoursLeft > 0 ? `~${formatDuration(hoursLeft * 3600)}` : '—',
		},
	];

	// finished_at is the fact; last_read_at is the fallback for a book marked
	// finished by hand without a closing session.
	const finishedDay = zonedDay(book.finished_at ?? book.last_read_at);
	const author = book.authors;
	const byline = author ? `${author} · ` : '';

	return {
		id: book.id,
		done: book.finished_at !== null || (progress !== null && progress >= FINISHED_PROGRESS),
		tracked: true,
		main,
		sub,
		author,
		progress,
		pages: book.ol_pages ?? total,
		coverUrl: book.cover_url,
		spineWidth: spineWidth(total, book.ol_pages),
		spineFill: progress === null ? 0 : Math.max(2, Math.round(progress * SPINE_HEIGHT)),
		pagesLabel: total
			? `${formatNumber(furthest)} / ${formatNumber(total)}`
			: `page ${formatNumber(furthest)}`,
		percent: progress === null ? null : formatPercent(progress),
		facts,
		untrackedNote: null,
		readTime: formatDuration(seconds),
		firstDay,
		lastDay,
		daysAgo,
		finishedDate: formatMonth(finishedDay),
		finishedYear: Number(finishedDay.slice(0, 4)),
		finishedMeta:
			`${byline}${formatNumber(distinct)} pages read over ${plural(daysRead, 'day')}` +
			` · ${formatDay(firstDay)} → ${formatDay(lastDay)}`,
		asideMeta:
			`${byline}reached ${total ? `page ${formatNumber(furthest)} of ${formatNumber(total)}` : `page ${formatNumber(furthest)}`}` +
			` · last opened ${formatDay(lastDay)}`,
	};
}

/** Half-star rating as text. Matches the book page and the film log. */
function stars(rating: number): string {
	return '★'.repeat(Math.floor(rating)) + (rating % 1 >= 0.5 ? '½' : '');
}

/** "27–31 Mar 2025", collapsing to one date or opening out across months. */
function readRange(from: string, to: string): string {
	if (from === to) return formatDay(from);
	if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${formatDay(to)}`;
	return `${formatDay(from)} → ${formatDay(to)}`;
}

/**
 * A book with no recorded sessions, in the shape the finished shelf renders.
 *
 * Every page-derived field is a placeholder, and deliberately an empty one: no
 * percentage, no pages label, no time. The alternative — a 0%, a "0 pages", a
 * "0m" — is not a smaller claim than the truth, it is a different and false one,
 * and it would sit in the same column as figures that were actually measured.
 *
 * The spine is drawn full rather than empty. Its fill means "how much of this
 * book have you read", and the answer here is all of it; only the page count
 * behind the width is unknown, which is what the default width already says.
 */
export function toOfflineView(book: OfflineRead, todayDay = today()): BookView {
	const { main, sub } = splitTitle(book.title);
	const finishedDay = zonedDay(book.finished_at);
	const firstDay = book.read_from ?? finishedDay;
	const lastDay = book.read_to ?? finishedDay;
	const author = book.authors;

	const meta = [
		author,
		book.read_from && book.read_to ? `read ${readRange(book.read_from, book.read_to)}` : null,
		book.rating != null ? stars(book.rating) : null,
		book.reads > 1 ? `${book.reads} reads` : null,
		'no page data',
	].filter(Boolean) as string[];

	return {
		id: book.id,
		done: true,
		tracked: false,
		main,
		sub,
		author,
		progress: null,
		pages: book.ol_pages ?? book.total_pages,
		// `book_offline_reads` doesn't carry one, and these only ever appear on the
		// finished shelf, which is spines all the way along.
		coverUrl: null,
		spineWidth: spineWidth(book.total_pages, book.ol_pages),
		spineFill: SPINE_HEIGHT,
		pagesLabel: '—',
		percent: null,
		facts: [],
		untrackedNote: null,
		readTime: '—',
		firstDay,
		lastDay,
		daysAgo: daysBetween(lastDay, todayDay),
		finishedDate: formatMonth(finishedDay),
		finishedYear: Number(finishedDay.slice(0, 4)),
		finishedMeta: meta.join(' · '),
		asideMeta: '',
	};
}

/**
 * A book started by hand rather than by a sync, in the shape the shelf renders.
 *
 * Same principle as toOfflineView: every page-derived field is empty rather than
 * zero. A 0% bar next to a book that is genuinely being read would say the
 * reading had stalled, when what is true is that nothing is counting it — so the
 * card carries a line saying that instead of a bar saying nothing.
 */
export function toManualView(book: ManualRead, todayDay = today()): BookView {
	const { main, sub } = splitTitle(book.title);
	const startedDay = zonedDay(book.started_at);
	const days = daysBetween(startedDay, todayDay);

	return {
		id: book.id,
		done: false,
		tracked: false,
		main,
		sub,
		author: book.authors,
		progress: null,
		pages: book.ol_pages ?? book.total_pages,
		coverUrl: book.cover_url,
		spineWidth: spineWidth(book.total_pages, book.ol_pages),
		spineFill: 0,
		pagesLabel: '—',
		percent: null,
		facts: [
			{ k: 'Started', v: formatDay(startedDay) },
			{ k: 'On it', v: days <= 0 ? 'since today' : plural(days, 'day') },
			{
				k: 'Length',
				v: book.ol_pages ?? book.total_pages
					? `${formatNumber((book.ol_pages ?? book.total_pages)!)} pages`
					: '—',
			},
		],
		untrackedNote: `Started ${formatDay(startedDay)} — nothing is counting the pages.`,
		readTime: '—',
		firstDay: startedDay,
		lastDay: startedDay,
		// Sorts by when it was started, alongside the tracked books' last page turn.
		daysAgo: days,
		finishedDate: formatMonth(startedDay),
		finishedYear: Number(startedDay.slice(0, 4)),
		finishedMeta: '',
		asideMeta: '',
	};
}

export interface Shelf {
	current: BookView[];
	setAside: BookView[];
	finished: BookView[];
}

/**
 * The three lists the page shows, from the three the database answers with.
 *
 * The queries split on `finished_at` and recency; this re-sorts the result on
 * FINISHED_PROGRESS as well, which moves a book read to its last page out of
 * whichever in-progress list it landed in. Every book still appears exactly
 * once — the whole point of the three headings is that they partition.
 */
export function buildShelf(
	currentRaw: BookProgress[],
	setAsideRaw: BookProgress[],
	finishedRaw: BookProgress[],
	offlineRaw: OfflineRead[] = [],
	manualRaw: ManualRead[] = [],
	todayDay = today(),
): Shelf {
	const view = (b: BookProgress) => toBookView(b, todayDay);
	const inFlight = [...currentRaw.map(view), ...setAsideRaw.map(view)];

	return {
		// Books started by hand join the tracked ones in date order rather than
		// sitting in a block above or below them: they are being read now, which is
		// the only thing this heading claims. They never go stale into "Set aside"
		// — that is thirty days of silence from the sync, and nothing is syncing
		// these to fall silent.
		current: [
			...manualRaw.map((b) => toManualView(b, todayDay)),
			...inFlight.filter((b) => !b.done && b.daysAgo <= CURRENTLY_READING_DAYS),
		].sort((a, b) => a.daysAgo - b.daysAgo),
		setAside: inFlight.filter((b) => !b.done && b.daysAgo > CURRENTLY_READING_DAYS),
		// Sorted by when reading stopped, so books promoted by progress interleave
		// with hand-marked ones instead of being appended after them — and so books
		// with no sessions behind them sit in date order among the tracked ones
		// rather than in a second list underneath, which would sort the shelf by
		// how well each entry happens to be recorded.
		finished: [
			...finishedRaw.map(view),
			...inFlight.filter((b) => b.done),
			...offlineRaw.map((b) => toOfflineView(b, todayDay)),
		].sort((a, b) => (a.lastDay < b.lastDay ? 1 : -1)),
	};
}

/** A day with reading on it. The zeros that pad the heatmap are dropped here. */
export interface ActivityDay {
	day: string;
	pages: number;
	seconds: number;
}

/** The days that had reading in them, oldest first. */
export function readDays(heatmap: HeatmapDay[]): ActivityDay[] {
	return heatmap
		.filter((d) => Number(d.pages_read) > 0)
		.map((d) => ({
			day: String(d.day).slice(0, 10),
			pages: Number(d.pages_read),
			seconds: Number(d.seconds_read),
		}))
		.sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Shading step 0–4, relative to the busiest day on record. */
export function heatLevel(pages: number, max: number): number {
	if (!pages) return 0;
	const ratio = pages / max;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
}

export const HEAT_LEVELS = [0, 1, 2, 3, 4];

/** A single square in either activity view. */
export interface ActivityCell {
	/** Tooltip. Empty for the padding cells outside the heatmap's date range. */
	title: string;
	level: number;
	read: boolean;
	inRange: boolean;
}

export interface SpellRow {
	kind: 'break' | 'spell';
	/** A date range for a spell, "5 quiet months" for a break. */
	label: string;
	meta: string;
	cells: ActivityCell[];
	/** Titles touched during the spell, or "—" when they were all private. */
	books: string;
}

/** Days closer together than this belong to the same spell. */
const SPELL_GAP_DAYS = 3;
/** How many spells to show. Older ones are scrollback nobody reads. */
const MAX_SPELLS = 8;

/** "13–22 Apr 2025", collapsing to one date or opening out across months. */
function spellLabel(from: string, to: string): string {
	if (from === to) return formatDay(from);
	if (from.slice(0, 7) === to.slice(0, 7)) {
		return `${Number(from.slice(8))}–${formatDay(to)}`;
	}
	return `${formatDay(from)} → ${formatDay(to)}`;
}

function cellFor(day: string, record: ActivityDay | undefined, maxPages: number): ActivityCell {
	const detail = record
		? ` · ${formatNumber(record.pages)} pages · ${formatDuration(record.seconds)}`
		: ' · nothing read';
	return {
		title: formatDay(day) + detail,
		level: record ? heatLevel(record.pages, maxPages) : 0,
		read: !!record,
		inRange: true,
	};
}

/**
 * The activity view for someone who reads in bursts: clusters of days with
 * reading in them, with the empty stretches between named rather than drawn.
 *
 * A calendar heatmap of a year containing three weeks of reading is a year of
 * blank squares; this shows the three weeks at full size and says "10 quiet
 * months" where the blanks were.
 *
 * Returned newest first, so the most recent reading is the first thing on the
 * page. The rows are built chronologically and reversed at the end rather than
 * walked backwards: a break describes the gap between the two spells it sits
 * between, and reversing the whole list keeps every break between the same pair.
 */
export function buildSpells(
	days: ActivityDay[],
	books: Pick<BookView, 'main' | 'firstDay' | 'lastDay'>[],
	maxPages: number,
): SpellRow[] {
	if (!days.length) return [];

	const clusters: ActivityDay[][] = [];
	let run: ActivityDay[] = [days[0]];
	for (let i = 1; i < days.length; i++) {
		if (daysBetween(days[i - 1].day, days[i].day) <= SPELL_GAP_DAYS) run.push(days[i]);
		else {
			clusters.push(run);
			run = [days[i]];
		}
	}
	clusters.push(run);

	const shown = clusters.slice(-MAX_SPELLS);
	const byDay = new Map(days.map((d) => [d.day, d]));
	const rows: SpellRow[] = [];

	shown.forEach((cluster, i) => {
		if (i > 0) {
			const previous = shown[i - 1];
			const gap = daysBetween(previous[previous.length - 1].day, cluster[0].day);
			rows.push({
				kind: 'break',
				label: gap >= 60 ? `${Math.round(gap / 30.4)} quiet months` : `${gap} quiet days`,
				meta: '',
				cells: [],
				books: '',
			});
		}

		const from = cluster[0].day;
		const to = cluster[cluster.length - 1].day;
		const cells: ActivityCell[] = [];
		for (let offset = 0; offset <= daysBetween(from, to); offset++) {
			const day = addDays(from, offset);
			cells.push(cellFor(day, byDay.get(day), maxPages));
		}

		const pages = cluster.reduce((sum, d) => sum + d.pages, 0);
		const seconds = cluster.reduce((sum, d) => sum + d.seconds, 0);
		const titles = books.filter((b) => b.firstDay <= to && b.lastDay >= from).map((b) => b.main);

		rows.push({
			kind: 'spell',
			label: spellLabel(from, to),
			meta: `${plural(cluster.length, 'day')} · ${formatNumber(pages)} pages · ${formatDuration(seconds)}`,
			cells,
			books: titles.length ? titles.join(' · ') : '—',
		});
	});

	return rows.reverse();
}

export interface HeatColumn {
	/** Month name on the first column of each month, empty otherwise. */
	month: string;
	cells: ActivityCell[];
}

export interface Heatmap {
	columns: HeatColumn[];
	/** "Aug 2025 → Aug 2026". */
	span: string;
}

/** Row labels down the side of the heatmap; the blanks keep it from crowding. */
export const DOW_LABELS = ['M', '', 'W', '', 'F', '', 'S'];

/**
 * Columns at the right edge that give up their month name.
 *
 * A month label is wider than the column it sits on and leans into the ones
 * after it, which is fine mid-grid — the next column is empty for as long as the
 * month lasts. At the end of the grid there is nothing to lean into, so the name
 * either overflows the card or gets clipped mid-word.
 */
const LABEL_EDGE_COLUMNS = 2;

/**
 * The last year as week columns, Monday at the top.
 *
 * The window opens on a Monday rather than exactly 364 days back. Starting mid
 * week leaves the first column with its top cells missing, and a hole in the
 * corner of a calendar reads as missing data rather than as the edge of the
 * window. The three or four extra days cost nothing: this view claims to be a
 * year of reading, not a precise count of days.
 *
 * The right edge stays ragged, because there the missing cells are days that
 * have not happened yet.
 */
export function buildHeatmap(
	days: ActivityDay[],
	maxPages: number,
	todayDay = today(),
): Heatmap {
	const yearAgo = addDays(todayDay, -364);
	const start = addDays(yearAgo, -((new Date(dayMs(yearAgo)).getUTCDay() + 6) % 7));
	const byDay = new Map(days.map((d) => [d.day, d]));

	const columns: HeatColumn[] = [];
	let labelled = -1;
	for (let week = 0; week * 7 <= daysBetween(start, todayDay); week++) {
		const columnStart = addDays(start, week * 7);
		const cells: ActivityCell[] = [];
		for (let dow = 0; dow < 7; dow++) {
			const day = addDays(columnStart, dow);
			if (day > todayDay) {
				cells.push({ title: '', level: 0, read: false, inRange: false });
			} else {
				cells.push(cellFor(day, byDay.get(day), maxPages));
			}
		}
		const month = Number(columnStart.slice(5, 7));
		// Label the column that opens a month, but only when the month actually
		// starts inside it — otherwise the label sits a week off.
		const showLabel = month !== labelled && Number(columnStart.slice(8)) <= 7;
		if (showLabel) labelled = month;
		columns.push({ month: showLabel ? MONTHS[month - 1] : '', cells });
	}

	// Dropped rather than clipped: half a month name is a typo, and the column
	// under it is still dated by the ones to its left.
	for (const column of columns.slice(-LABEL_EDGE_COLUMNS)) column.month = '';

	return { columns, span: `${formatMonth(start)} → ${formatMonth(todayDay)}` };
}

/**
 * Whether there is enough reading in the last year for a calendar to be worth
 * drawing. Both halves matter: 60 days all in one fortnight is a spell, not a
 * habit, and 14 scattered weeks of one page each is not a year of reading.
 */
export function prefersHeatmap(days: ActivityDay[], todayDay = today()): boolean {
	const recent = days.filter((d) => daysBetween(d.day, todayDay) <= 365);
	const monday = dayMs('2020-01-06');
	const weeks = new Set(recent.map((d) => Math.floor((dayMs(d.day) - monday) / (7 * DAY_MS))));
	return recent.length >= 60 && weeks.size >= 14;
}

/** "12 days read across 16 months" — the caption over the activity view. */
export function activityMeta(days: ActivityDay[]): string {
	if (!days.length) return 'nothing logged yet';
	const span = daysBetween(days[0].day, days[days.length - 1].day) + 1;
	const spanLabel = span >= 60 ? `${Math.round(span / 30.4)} months` : `${span} days`;
	return `${plural(days.length, 'day')} read across ${spanLabel}`;
}
