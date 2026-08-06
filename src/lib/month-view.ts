// The "Month in film" share card, as pure functions.
//
// The card is a fixed 1080-wide artboard that gets exported as a PNG, so every
// number in it — cell size, gutters, the offset each poster in a stack peeks out
// by — is derived here rather than left to the layout. The page scales the whole
// artboard down to fit the screen; the element itself stays 1080px so the export
// is the same drawing at full size.
//
// DAYS ARE STRINGS. `watched_date` is a calendar day, never an instant, so the
// weekday of the 1st is computed arithmetically (see `firstWeekdayIndex`) and no
// `Date` is constructed from a day string anywhere in this file.

import { imageUrl } from './tmdb';

/** A diary watch as the card needs it — one row per watch, not per film. */
export interface MonthWatch {
	id: number;
	watched_date: string;
	rating: number | null;
	liked: boolean;
	rewatched: boolean;
	created_at: string;
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	runtime: number | null;
}

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

export const MONTH_ABBR = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];

/** Monday-first, to match the card. */
export const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A "YYYY-MM" key, or null if it isn't one. Rejects month 00 and 13. */
export function parseMonthKey(value: string | undefined): { year: number; month: number } | null {
	if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	if (month < 1 || month > 12) return null;
	return { year, month };
}

export function monthKey(year: number, month: number): string {
	return `${year}-${pad2(month)}`;
}

/** The month a "YYYY-MM-DD" day falls in. */
export function monthOf(day: string): string {
	return day.slice(0, 7);
}

export function monthLabel(key: string): string {
	const parsed = parseMonthKey(key);
	if (!parsed) return key;
	return `${MONTHS[parsed.month - 1]} ${parsed.year}`;
}

/** `key` moved `delta` months, wrapping the year. */
export function shiftMonth(key: string, delta: number): string {
	const parsed = parseMonthKey(key);
	if (!parsed) return key;
	const total = parsed.year * 12 + (parsed.month - 1) + delta;
	return monthKey(Math.floor(total / 12), (((total % 12) + 12) % 12) + 1);
}

export function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		return leap ? 29 : 28;
	}
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Which column the 1st sits in, Monday-first (0 = Monday). Sakamoto's method —
 * pure arithmetic on the calendar, so it can't drift with the runtime's zone the
 * way `new Date('2026-07-01').getDay()` does.
 */
export function firstWeekdayIndex(year: number, month: number): number {
	const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
	const y = month < 3 ? year - 1 : year;
	const sunFirst =
		(y +
			Math.floor(y / 4) -
			Math.floor(y / 100) +
			Math.floor(y / 400) +
			t[month - 1] +
			1) %
		7;
	return (sunFirst + 6) % 7;
}

/**
 * A day's watches in stack order: best on top, ties broken by the entry logged
 * first, unrated last. `id` breaks the remaining ties because the Letterboxd
 * import stamps a whole batch with one `created_at`.
 */
export function sortDayWatches(watches: MonthWatch[]): MonthWatch[] {
	return watches.slice().sort((a, b) => {
		const ar = a.rating ?? -1;
		const br = b.rating ?? -1;
		if (ar !== br) return br - ar;
		if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
		return a.id - b.id;
	});
}

/** A poster in a stack. `layer` 0 is the top card; 1+ peek out behind it. */
export interface CellFilm {
	tmdbId: number;
	title: string;
	year: number | null;
	poster: string | null;
	liked: boolean;
	layer: number;
	/** Degrees this print is rotated by; alternates so a stack looks hand-set. */
	rotation: number;
	/** What shows where the poster doesn't — see `ground`. */
	ground: string;
}

/** Warm grounds for prints with no poster, picked off the film so a stack of
 *  them doesn't read as one flat block. */
const TONES: readonly [string, string][] = [
	['#3a1d1e', '#2e1618'],
	['#33201a', '#281812'],
	['#2c1a22', '#21131a'],
	['#3a2418', '#2c1a12'],
	['#2e1d1a', '#231413'],
];

/**
 * The hatched fill behind a print. TMDB has no poster for some films, and a hole
 * in the middle of the grid reads as a bug; this reads as a blank print.
 */
export function ground(tmdbId: number): string {
	const [a, b] = TONES[Math.abs(tmdbId) % TONES.length];
	return `repeating-linear-gradient(135deg, ${a} 0 9px, ${b} 9px 18px)`;
}

export interface MonthCell {
	/** A padding cell before the 1st or after the last — drawn as nothing. */
	outside: boolean;
	date: number;
	/** Watches that day, top of the stack first. Empty on a day with no film. */
	films: CellFilm[];
	/** Prints drawn behind the top one, deepest first. Capped at LAYERS. */
	behind: CellFilm[];
	/** The true count, even when the stack draws fewer prints than that. */
	count: number;
	/** Every film that day, for the hover tooltip. */
	lines: string[];
}

/** How many prints peek out behind the top one. Deeper stacks just cast more shadow. */
const LAYERS = 3;

function toCellFilm(watch: MonthWatch, layer: number): CellFilm {
	return {
		tmdbId: watch.tmdb_id,
		title: watch.title,
		year: watch.release_year,
		poster: imageUrl(watch.poster_path, 'w342'),
		liked: watch.liked,
		layer,
		rotation: layer % 2 ? 1.5 : -1.7,
		ground: ground(watch.tmdb_id),
	};
}

/** The month's cells, in reading order, padded out to whole weeks. */
export function buildCells(key: string, watches: MonthWatch[]): MonthCell[] {
	const parsed = parseMonthKey(key);
	if (!parsed) return [];
	const { year, month } = parsed;
	const days = daysInMonth(year, month);
	const first = firstWeekdayIndex(year, month);

	const byDay = new Map<number, MonthWatch[]>();
	for (const watch of watches) {
		const day = Number(watch.watched_date.slice(8, 10));
		const list = byDay.get(day);
		if (list) list.push(watch);
		else byDay.set(day, [watch]);
	}

	const cells: MonthCell[] = [];
	for (let i = 0; i < weekRows(key) * 7; i++) {
		const date = i - first + 1;
		if (date < 1 || date > days) {
			cells.push({ outside: true, date: 0, films: [], behind: [], count: 0, lines: [] });
			continue;
		}
		const day = sortDayWatches(byDay.get(date) ?? []);
		const films = day.map(toCellFilm);
		cells.push({
			outside: false,
			date,
			films,
			// Deepest first so the DOM paints them in the order they overlap.
			behind: films.slice(1, LAYERS + 1).reverse(),
			count: films.length,
			lines: day.map((f) => `${f.title}${f.release_year ? ` (${f.release_year})` : ''}`),
		});
	}
	return cells;
}

/** Rows of the grid — 4, 5 or 6, depending on where the 1st lands. */
export function weekRows(key: string): number {
	const parsed = parseMonthKey(key);
	if (!parsed) return 5;
	const { year, month } = parsed;
	return Math.ceil((firstWeekdayIndex(year, month) + daysInMonth(year, month)) / 7);
}

export interface Aspect {
	id: string;
	/** What it's called in a URL — the id has a colon in it. */
	slug: string;
	label: string;
	height: number;
}

/** The three share sizes. All 1080 wide; only the height changes. */
export const ASPECTS: readonly Aspect[] = [
	{ id: '4:5', slug: 'feed', label: 'Feed', height: 1350 },
	{ id: '1:1', slug: 'square', label: 'Square', height: 1080 },
	{ id: '9:16', slug: 'story', label: 'Story', height: 1920 },
];

/** The aspect a `?fmt=` names, or the default for anything unrecognised. */
export function aspectBySlug(slug: string | null): Aspect {
	return ASPECTS.find((a) => a.slug === slug) ?? ASPECTS[0];
}

/**
 * The card's settings as a query string, so stepping to another month keeps
 * them — each step is a real navigation, and a copied link should reproduce the
 * card that was on screen. Defaults are left out, so the plain URL stays clean.
 *
 * The client mirrors this when it rewrites the month links; keep the two in step.
 */
export function monthQuery(aspect: Aspect, showLikes: boolean): string {
	const parts: string[] = [];
	if (aspect.slug !== ASPECTS[0].slug) parts.push(`fmt=${aspect.slug}`);
	if (!showLikes) parts.push('likes=0');
	return parts.length ? `?${parts.join('&')}` : '';
}

export const CARD_WIDTH = 1080;
const PAD = 46;
const GUTTER = 10;
/** Vertical space the header, summary and footer take, whatever the aspect. */
const CHROME = 404;

export interface Geometry {
	height: number;
	cell: number;
	grid: number;
}

/**
 * The poster size that fits both ways: seven across the artboard's width, and
 * `rows` down whatever height the chosen aspect leaves after the chrome. The
 * short aspects are height-bound, the story aspect is width-bound.
 */
export function geometry(rows: number, height: number): Geometry {
	const byWidth = (CARD_WIDTH - 2 * PAD - 6 * GUTTER) / 7;
	const byHeight = (height - CHROME - (rows - 1) * GUTTER) / rows / 1.5;
	const cell = Math.min(byWidth, byHeight);
	return { height, cell, grid: cell * 7 + GUTTER * 6 };
}

/** Geometry for every aspect, keyed by id — the aspect toggle just swaps these in. */
export function geometries(rows: number): Record<string, Geometry> {
	const out: Record<string, Geometry> = {};
	for (const aspect of ASPECTS) out[aspect.id] = geometry(rows, aspect.height);
	return out;
}

export interface SummaryStat {
	label: string;
	value: string;
}

/**
 * The three figures under the grid.
 *
 * **Films** counts distinct `tmdb_id`, so a film watched twice in the month is
 * one film even though it holds two cells in the grid above. **In the seat**
 * deliberately does not: every watch is time spent, so a rewatch is counted
 * again. The labels carry that difference.
 */
export function summarise(key: string, watches: MonthWatch[]): SummaryStat[] {
	const distinct = new Set(watches.map((w) => w.tmdb_id));
	const minutes = watches.reduce((total, w) => total + (w.runtime ?? 0), 0);
	const streak = longestStreak(key, watches);
	return [
		{ label: 'Films', value: String(distinct.size) },
		{ label: 'In the seat', value: `${Math.round(minutes / 60)}h` },
		{ label: 'Longest streak', value: `${streak} ${streak === 1 ? 'day' : 'days'}` },
	];
}

/** The longest run of consecutive days with at least one watch, within the month. */
export function longestStreak(key: string, watches: MonthWatch[]): number {
	const parsed = parseMonthKey(key);
	if (!parsed) return 0;
	const seen = new Set(watches.map((w) => Number(w.watched_date.slice(8, 10))));
	let longest = 0;
	let run = 0;
	for (let day = 1; day <= daysInMonth(parsed.year, parsed.month); day++) {
		run = seen.has(day) ? run + 1 : 0;
		if (run > longest) longest = run;
	}
	return longest;
}
