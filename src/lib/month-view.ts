// The "Month in film" share card, as pure functions.
//
// The card is a fixed 1080-wide artboard that gets exported as a PNG, so every
// number in it — cell size, gutters, the offset each poster in a stack peeks out
// by — is derived here rather than left to the layout. The page scales the whole
// artboard down to fit the screen; the element itself stays 1080px so the export
// is the same drawing at full size.
//
// The calendar arithmetic and the artboard itself are shared with the reading
// card and live in share-card.ts; this file re-exports what the page needs so
// there is one import for the page to reach for. What's genuinely film's own —
// the stack order, the poster sizes, the summary — is here.

import { imageUrl } from './tmdb';
import {
	ASPECTS,
	daysInMonth,
	firstWeekdayIndex,
	geometry as cardGeometry,
	longestStreak as runOfDays,
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
	type Geometry,
} from './share-card';

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

/**
 * Which TMDB size a print asks for.
 *
 * A cell is 120–133px on the 1080 artboard, and about 62% of that on screen, so
 * w342 was arriving at three to four times the size it gets drawn at — and a
 * poster resampled that far down aliases, especially the type on it. w185 still
 * exceeds the biggest cell, so the export never upscales, while roughly halving
 * how far the browser has to squeeze it.
 *
 * A print behind the top one shows a few pixels of margin and nothing else,
 * so it gets the small size: sharper for its size, and a third of the bytes on
 * a page that can hold forty of them.
 */
function posterSize(layer: number) {
	return layer === 0 ? 'w185' : 'w92';
}

function toCellFilm(watch: MonthWatch, layer: number): CellFilm {
	return {
		tmdbId: watch.tmdb_id,
		title: watch.title,
		year: watch.release_year,
		poster: imageUrl(watch.poster_path, posterSize(layer)),
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

/** Vertical space the header, summary and footer take, whatever the aspect. */
const CHROME = 404;

/** Geometry for every aspect, keyed by id — the aspect toggle just swaps these in. */
export function geometries(rows: number): Record<string, Geometry> {
	const out: Record<string, Geometry> = {};
	for (const aspect of ASPECTS) out[aspect.id] = cardGeometry(rows, aspect.height, CHROME);
	return out;
}

/** The film card's settings in a query string: the aspect, and the likes switch. */
export function monthQuery(aspect: Aspect, showLikes: boolean): string {
	return cardQuery(aspect, showLikes ? {} : { likes: '0' });
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
	return runOfDays(
		key,
		watches.map((w) => w.watched_date),
	);
}
