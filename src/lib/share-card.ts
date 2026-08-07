// What the two month cards — "The month in film" and "The month in reading" —
// have in common: the calendar the grid is drawn on, the artboard they're drawn
// at, and the settings that have to survive stepping to another month.
//
// The cards themselves are not shared. They stack different things, count
// different things, and one of them hides its summary at two of the three
// aspects. Only the arithmetic lives here.
//
// DAYS ARE STRINGS. A calendar day is not an instant, so nothing in this file
// constructs a Date — the weekday of the 1st comes out of `firstWeekdayIndex`.

const pad2 = (n: number) => String(n).padStart(2, '0');

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

/** Monday-first, to match both cards. */
export const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

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
		(y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[month - 1] + 1) % 7;
	return (sunFirst + 6) % 7;
}

/** Rows of the grid — 4, 5 or 6, depending on where the 1st lands. */
export function weekRows(key: string): number {
	const parsed = parseMonthKey(key);
	if (!parsed) return 5;
	const { year, month } = parsed;
	return Math.ceil((firstWeekdayIndex(year, month) + daysInMonth(year, month)) / 7);
}

/** The longest run of consecutive days in `days` that fall inside the month. */
export function longestStreak(key: string, days: Iterable<string>): number {
	const parsed = parseMonthKey(key);
	if (!parsed) return 0;
	const seen = new Set<number>();
	for (const day of days) if (monthOf(day) === key) seen.add(Number(day.slice(8, 10)));
	let longest = 0;
	let run = 0;
	for (let day = 1; day <= daysInMonth(parsed.year, parsed.month); day++) {
		run = seen.has(day) ? run + 1 : 0;
		if (run > longest) longest = run;
	}
	return longest;
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
 * A card's settings as a query string, so stepping to another month keeps
 * them — each step is a real navigation, and a copied link should reproduce the
 * card that was on screen. Defaults are left out, so the plain URL stays clean.
 *
 * The client mirrors this when it rewrites the month links; keep the two in step.
 */
export function monthQuery(aspect: Aspect, extra: Record<string, string> = {}): string {
	const parts: string[] = [];
	if (aspect.slug !== ASPECTS[0].slug) parts.push(`fmt=${aspect.slug}`);
	for (const [key, value] of Object.entries(extra)) parts.push(`${key}=${value}`);
	return parts.length ? `?${parts.join('&')}` : '';
}

export const CARD_WIDTH = 1080;
export const CARD_PAD = 46;
export const CARD_GUTTER = 10;

export interface Geometry {
	height: number;
	cell: number;
	grid: number;
}

/**
 * The print size that fits both ways: seven across the artboard's width, and
 * `rows` down whatever height is left once `chrome` — the header, summary and
 * footer — has taken its share. Short aspects come out height-bound, the story
 * aspect width-bound.
 */
export function geometry(rows: number, height: number, chrome: number): Geometry {
	const byWidth = (CARD_WIDTH - 2 * CARD_PAD - 6 * CARD_GUTTER) / 7;
	const byHeight = (height - chrome - (rows - 1) * CARD_GUTTER) / rows / 1.5;
	const cell = Math.min(byWidth, byHeight);
	return { height, cell, grid: cell * 7 + CARD_GUTTER * 6 };
}
