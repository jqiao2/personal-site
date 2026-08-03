// Presentation layer for /reading: turns the aggregates in reading-queries.ts
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
import { CURRENTLY_READING_DAYS, type BookProgress, type HeatmapDay } from './reading-queries';

/** The zone the stored day boundaries are measured in. Must match migration 0020. */
export const READING_TZ = 'America/New_York';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// en-CA formats as YYYY-MM-DD, which is the shape the SQL side already uses.
const dayFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: READING_TZ,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/** The local day an instant falls on, e.g. a `last_read_at` timestamptz. */
export function zonedDay(when: string | Date): string {
	return dayFormat.format(typeof when === 'string' ? new Date(when) : when);
}

/** Today, in the reading timezone. */
export function today(): string {
	return zonedDay(new Date());
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
 * Spine width from page count — a long book looks like a long book. Square root
 * because raw page counts span two orders of magnitude (a 238-page novel next to
 * The Power Broker's 3,943) and a linear scale would make everything but the
 * doorstop a sliver.
 */
function spineWidth(totalPages: number | null): number {
	if (!totalPages) return 14;
	return Math.max(9, Math.min(34, Math.round(Math.sqrt(totalPages) * 0.62)));
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
	main: string;
	sub: string | null;
	author: string | null;
	/** 0–1, or null when the book's page count is unknown. */
	progress: number | null;
	spineWidth: number;
	spineFill: number;
	/** "627 / 628", or "page 106" when there is no total to divide by. */
	pagesLabel: string;
	/** "99.8%", or null when progress is unknown. */
	percent: string | null;
	facts: BookFact[];
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
const FINISHED_PROGRESS = 0.97;

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
		main,
		sub,
		author,
		progress,
		spineWidth: spineWidth(total),
		spineFill: progress === null ? 0 : Math.max(2, Math.round(progress * SPINE_HEIGHT)),
		pagesLabel: total
			? `${formatNumber(furthest)} / ${formatNumber(total)}`
			: `page ${formatNumber(furthest)}`,
		percent: progress === null ? null : formatPercent(progress),
		facts,
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
	todayDay = today(),
): Shelf {
	const view = (b: BookProgress) => toBookView(b, todayDay);
	const inFlight = [...currentRaw.map(view), ...setAsideRaw.map(view)];

	return {
		current: inFlight.filter((b) => !b.done && b.daysAgo <= CURRENTLY_READING_DAYS),
		setAside: inFlight.filter((b) => !b.done && b.daysAgo > CURRENTLY_READING_DAYS),
		// Sorted by when reading stopped, so books promoted by progress interleave
		// with hand-marked ones instead of being appended after them.
		finished: [...finishedRaw.map(view), ...inFlight.filter((b) => b.done)].sort((a, b) =>
			a.lastDay < b.lastDay ? 1 : -1,
		),
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

/** The last twelve months as week columns, Monday at the top. */
export function buildHeatmap(
	days: ActivityDay[],
	maxPages: number,
	todayDay = today(),
): Heatmap {
	const start = addDays(todayDay, -364);
	// Back up to the Monday on or before the start, so every column is a full week.
	const weekStart = addDays(start, -((new Date(dayMs(start)).getUTCDay() + 6) % 7));
	const byDay = new Map(days.map((d) => [d.day, d]));

	const columns: HeatColumn[] = [];
	let labelled = -1;
	for (let week = 0; week * 7 <= daysBetween(weekStart, todayDay) + 6; week++) {
		const columnStart = addDays(weekStart, week * 7);
		const cells: ActivityCell[] = [];
		for (let dow = 0; dow < 7; dow++) {
			const day = addDays(columnStart, dow);
			if (day < start || day > todayDay) {
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
