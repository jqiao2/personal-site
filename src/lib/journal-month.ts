// "The month in review" — all four logs on one calendar, as pure functions.
//
// WHAT MAKES THIS CARD DIFFERENT FROM THE OTHER FOUR. Each section's own month
// card answers "how was the month, in films / in books / in eating / in
// activities". This one answers a question none of them can: what a DAY was
// like. So a cell here is not a poster or a route or a plate — it's a cluster,
// one mark per thing done, and the marks are sized by the hours they took.
//
// TIME IS THE ONLY COMMON UNIT. A 4-star film and a 12-mile run and a taco are
// not comparable on any scale the four sections share — ratings mean different
// things, distance means nothing to a book. Minutes mean the same thing to all
// four, and minutes are what a day is actually made of. Sizing by time is
// therefore not a stylistic choice; it's the only honest way to draw a
// three-hour ride and a croissant on the same square.
//
// AREA, NOT WIDTH. A mark's AREA is proportional to its minutes, so its side
// grows as the square root. Setting the SIDE proportional to minutes instead
// would draw a 5-hour ride 15x wider than a twenty-minute pastry and therefore
// 225x its area — the eye reads the area, so that version overstates the ride
// by more than an order of magnitude. Under the square root it comes out 3.9x
// across, which is what 15x the time actually looks like. See `markSize`.
//
// The calendar arithmetic and the artboard come from share-card.ts, same as the
// other four.

import { photoSrc } from './photo-src';
import { sportIcon, sportMeta } from './sports';
import { imageUrl } from './tmdb';
import {
	daysInMonth,
	firstWeekdayIndex,
	parseMonthKey,
	weekRows,
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
	monthQuery,
	parseMonthKey,
	shiftMonth,
	weekRows,
	type Aspect,
} from './share-card';

export type Track = 'film' | 'book' | 'meal' | 'move';

export const TRACKS: readonly { id: Track; label: string }[] = [
	{ id: 'film', label: 'Films' },
	{ id: 'book', label: 'Books' },
	{ id: 'meal', label: 'Meals' },
	{ id: 'move', label: 'Activities' },
];

// ---------------------------------------------------------------------------
// The weights
// ---------------------------------------------------------------------------

/**
 * How long each kind of thing takes, when the row doesn't say.
 *
 * These are the calibration knobs, gathered here rather than scattered through
 * the four mappers, because they are the one part of this card that is a
 * judgement rather than a measurement and they will want tuning.
 *
 * `FILM_MINUTES` — TMDB is missing a runtime often enough to matter, and a
 * mark with no size is worse than a mark with an average one. 105 is close to
 * the median feature.
 *
 * `MEAL_MINUTES` / `SNACK_MINUTES` — a sit-down meal is an hour; a bakery, a
 * breakfast or a dessert is twenty minutes. That 3:1 ratio is the point: it
 * shows up as a 1.7x mark, which reads as "smaller thing, same day" rather
 * than as a different category of event.
 *
 * `BOOK_BOOST` — reading time is the only one of the four that is MEASURED
 * rather than assumed (KOReader reports real seconds per book per day), and
 * measured time is honest in a way that flatters nobody: it excludes the
 * paperback on the train and every minute read on a device that doesn't sync.
 * The 1.3x is a deliberate thumb on the scale to bring a tracked reading day
 * back up to the size the day actually was. It is a fudge, and is labelled one.
 *
 * `ACTIVITY` has no default: an activity always carries either moving or
 * elapsed seconds, so there is nothing to guess.
 */
export const FILM_MINUTES = 105;
export const MEAL_MINUTES = 60;
export const SNACK_MINUTES = 20;
export const BOOK_BOOST = 1.3;

/**
 * Words that mean "this was twenty minutes, not an hour".
 *
 * THE SNACK/MEAL SPLIT HAS NO COLUMN BEHIND IT. `restaurant_visits` records
 * `visited_on` as a date and nothing about the sitting — deliberately, per
 * migration 0030 ("nobody remembers what time they sat down"). So the split is
 * inferred from the free text that does exist: the place's cuisines, the
 * visit's tags, and the place's own name, which is where "Bakery" and "Coffee"
 * actually live.
 *
 * Kept to unambiguous words. "Brunch" is not here — brunch is a meal that
 * takes an hour and a half. Nor is "bar": drinks are not short.
 *
 * ponytail: keyword match on free text, ~90% right on this diary. The upgrade
 * is a `meal` enum on `restaurant_visits`; do it when a wrong-sized mark
 * actually bothers you, not before.
 */
const SNACK_WORDS = [
	'bakery',
	'bakeries',
	'boulangerie',
	'patisserie',
	'pâtisserie',
	'pastry',
	'pastries',
	'dessert',
	'desserts',
	'ice cream',
	'gelato',
	'frozen yogurt',
	'donut',
	'doughnut',
	'cookie',
	'cupcake',
	'chocolate',
	'candy',
	'cafe',
	'café',
	'coffee',
	'espresso',
	'tea house',
	'teahouse',
	'boba',
	'bubble tea',
	'juice',
	'smoothie',
	'breakfast',
	'bagel',
	'snack',
	'snacks',
];

/**
 * Whether a visit was a snack rather than a meal — see `SNACK_WORDS` for why
 * this is a guess and what would replace it.
 */
export function isSnack(fields: {
	restaurant_name?: string | null;
	cuisines?: string[] | null;
	tags?: string[] | null;
}): boolean {
	const haystack = [fields.restaurant_name ?? '', ...(fields.cuisines ?? []), ...(fields.tags ?? [])]
		.join(' ')
		.toLowerCase();
	return SNACK_WORDS.some((word) => haystack.includes(word));
}

/**
 * The mark geometry, in px on the 1080 artboard.
 *
 * `MARK_K` is set so a typical feature film (105 min) draws at ~50px: about a
 * third of a cell, so three ordinary things fit a day without the cluster
 * spilling. `MARK_MIN` is the floor at which a mark is still a picture of
 * something rather than a dot — a 20-minute snack lands just above it.
 * `MARK_MAX` caps the marathon days; past ~4h the mark has already said
 * "this was the day", and letting it grow further just evicts everything else
 * from the square.
 *
 *   20 min  → 22px    60 min  → 38px    105 min → 50px
 *   180 min → 66px    300+ min → 76px (capped)
 */
export const MARK_K = 4.9;
export const MARK_MIN = 22;
export const MARK_MAX = 76;

/**
 * How much of a cell a day's marks may cover before the cluster is shrunk to
 * fit — see `clusterScale`. A cell on the artboard is ~128px wide and, at the
 * shortest aspect, ~145px tall, less the cluster's 4px inset.
 */
export const CELL_INNER_AREA = 120 * 137;
export const INK_BUDGET = 0.66;

/**
 * How far a day's cluster has to shrink to stay inside its square.
 *
 * A busy day is real — five marks on one Saturday is a good Saturday, not a
 * bug — and the marks are already at the sizes the time earned, so the fix
 * cannot be to drop any of them or to cap them individually: both would break
 * the one promise the card makes, that a mark's size is its hours. Shrinking
 * the whole cluster by one factor keeps every ratio inside the day intact and
 * costs only the comparison BETWEEN days, which the cell is too small to carry
 * honestly anyway.
 *
 * Area-based rather than a real packing solve: the marks wrap, overlap and are
 * tilted, so their true footprint isn't computable here, and a budget with a
 * constant in front of it is one knob instead of a layout engine. `INK_BUDGET`
 * is calibrated against the busiest day in the log (five marks, 67px down to
 * 38px), which comes out at ~0.9 — visibly tightened, still a cluster.
 *
 * ponytail: area heuristic, not a packing solve. If a day ever spills, lower
 * INK_BUDGET rather than reaching for a bin-packer.
 */
export function clusterScale(marks: { size: number }[]): number {
	const ink = marks.reduce((total, m) => total + m.size * m.size, 0);
	if (ink === 0) return 1;
	return Math.min(1, Math.round(Math.sqrt((INK_BUDGET * CELL_INNER_AREA) / ink) * 100) / 100);
}

/** A mark's side, in artboard px, for `minutes` spent on it. Area ∝ minutes. */
export function markSize(minutes: number): number {
	const side = MARK_K * Math.sqrt(Math.max(0, minutes));
	return Math.round(Math.min(MARK_MAX, Math.max(MARK_MIN, side)));
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

/**
 * One thing done on one day, in the only shape this card cares about. The page
 * maps each section's own rows into this; nothing downstream of here knows
 * which table an item came from beyond its `track`.
 */
export interface JournalItem {
	track: Track;
	/** Unique within its track — used for the tilt, so a mark tilts the same way
	 *  on every load rather than by fetch order. */
	key: string;
	day: string;
	minutes: number;
	title: string;
	/** Second line in the tooltip: author, cuisine, sport, year. */
	detail: string;
	/** Cover, poster or photograph, already at the size it will be drawn. */
	image: string | null;
	/** A 24x24 path, drawn when there is no image. Activities always have one. */
	icon: string | null;
	/** Where the mark links to, if that thing has a page of its own. */
	href: string | null;
}

export interface JournalMark extends JournalItem {
	/** Side in artboard px. */
	size: number;
	/** Degrees of tilt — pinned to `key`, small, and never zero, so a cluster
	 *  looks stuck in by hand rather than laid out. */
	tilt: number;
}

/** A stable small number from a string — the tilt's only input. */
function hash(key: string): number {
	let h = 0;
	for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
	return Math.abs(h);
}

export function toMark(item: JournalItem): JournalMark {
	const h = hash(`${item.track}:${item.key}`);
	// Roughly -4°..+3°, and never 0 — a mark that happens to land square reads
	// as a layout, and the whole point of a cluster is that it isn't one.
	const tilt = ((h % 8) - 4 + (h % 2 ? 0.5 : -0.5)) * 0.9;
	return { ...item, size: markSize(item.minutes), tilt };
}

// ---------------------------------------------------------------------------
// The four mappers
//
// Each takes the rows the section's own month query already returns and turns
// them into `JournalItem`s. They live here rather than in the page because the
// weights above are only meaningful applied, and this is where they get
// applied — the calibration and its use should be readable in one file.
// Every parameter type is structural, so the real rows pass straight in.
// ---------------------------------------------------------------------------

interface WatchRow {
	id: number;
	watched_date: string;
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	runtime: number | null;
	rating: number | null;
}

export function filmItems(watches: WatchRow[]): JournalItem[] {
	return watches.map((w) => ({
		track: 'film' as const,
		key: String(w.id),
		day: w.watched_date,
		minutes: w.runtime ?? FILM_MINUTES,
		title: w.title,
		detail: w.release_year ? String(w.release_year) : 'Film',
		image: imageUrl(w.poster_path, 'w185'),
		icon: null,
		href: `/films/diary/${w.id}`,
	}));
}

interface DayRow {
	book_id: number;
	day: string;
	seconds: number;
}
/**
 * Open Library bakes the cover size into the URL, and what's on the row is
 * whichever the importer asked for, so the suffix is swapped rather than
 * trusted — the same rule `coverUrl` in reading-month-view.ts applies. It is
 * repeated here rather than imported because that module reaches the query
 * layer transitively, and this one is pure on purpose.
 */
function cover(url: string | null): string | null {
	return url ? url.replace(/-(S|M|L)\.jpg$/i, '-M.jpg') : null;
}

interface BookRow {
	id: number;
	title: string;
	authors: string | null;
	cover_url: string | null;
	is_public: boolean;
}

/**
 * One mark per book per day — the same rule the reading card uses, so a book
 * read over a fortnight holds a mark on each of those days rather than one on
 * the day it was finished.
 *
 * A private book keeps its size and loses its name: `getReadingMonth` already
 * blanks the title, and the link goes with it. The day it was read is not the
 * secret; the book is.
 */
export function bookItems(days: DayRow[], books: BookRow[]): JournalItem[] {
	const byId = new Map(books.map((b) => [b.id, b]));
	return days.map((d) => {
		const book = byId.get(d.book_id);
		const open = book?.is_public === true && !!book.title;
		return {
			track: 'book' as const,
			key: `${d.book_id}:${d.day}`,
			day: d.day,
			minutes: (d.seconds / 60) * BOOK_BOOST,
			title: open ? book!.title : 'A book',
			detail: open ? (book!.authors ?? 'Book') : 'Private',
			image: open ? cover(book!.cover_url) : null,
			icon: null,
			href: open ? `/books/${d.book_id}` : null,
		};
	});
}

interface VisitRow {
	id: number;
	visited_on: string;
	restaurant_name: string;
	cuisines: string[] | null;
	tags: string[] | null;
	neighborhood: string | null;
	photos?: { url: string }[];
}

export function mealItems(visits: VisitRow[]): JournalItem[] {
	return visits.map((v) => {
		const snack = isSnack(v);
		const photo = v.photos?.[0]?.url;
		return {
			track: 'meal' as const,
			key: String(v.id),
			day: v.visited_on,
			minutes: snack ? SNACK_MINUTES : MEAL_MINUTES,
			title: v.restaurant_name,
			detail: v.cuisines?.join(' · ') || v.neighborhood || (snack ? 'Snack' : 'Meal'),
			image: photo ? photoSrc(photo, 320) : null,
			icon: null,
			href: `/restaurants/diary/${v.id}`,
		};
	});
}

interface ActivityRow {
	id: number;
	sport: string;
	title: string;
	local_date: string;
	moving_seconds: number | null;
	elapsed_seconds: number;
}

export function activityItems(activities: ActivityRow[]): JournalItem[] {
	return activities.map((a) => ({
		track: 'move' as const,
		key: String(a.id),
		day: a.local_date,
		// Moving over elapsed, the convention the whole activities track uses:
		// a two-hour ride with a forty-minute coffee stop was a ride, not three hours.
		minutes: (a.moving_seconds ?? a.elapsed_seconds) / 60,
		title: a.title,
		detail: sportMeta(a.sport).label,
		image: null,
		icon: sportIcon(a.sport),
		href: `/activities/${a.id}`,
	}));
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export interface JournalCell {
	/** A padding cell before the 1st or after the last — drawn as blank paper. */
	outside: boolean;
	date: number;
	/** The day's marks, biggest first, so the cluster anchors on the main event. */
	marks: JournalMark[];
	/** Total minutes that day — what the day's ink weight is set from. */
	minutes: number;
	/** Which tracks the day touched, in TRACKS order — the day's little rubric. */
	tracks: Track[];
	/** 0..1 — how far the whole cluster shrinks so a busy day stays in its
	 *  square. See `clusterScale`. */
	scale: number;
}

/**
 * The month's cells, in reading order, padded out to whole weeks. Mirrors the
 * other four cards' `buildCells`, but a cell holds every item of every track
 * rather than one section's stack — the whole point of this card is that a
 * Tuesday with a ride, a chapter and a taco is one picture.
 */
export function buildCells(key: string, items: JournalItem[]): JournalCell[] {
	const parsed = parseMonthKey(key);
	if (!parsed) return [];
	const { year, month } = parsed;
	const days = daysInMonth(year, month);
	const first = firstWeekdayIndex(year, month);

	const byDay = new Map<number, JournalItem[]>();
	for (const item of items) {
		if (item.day.slice(0, 7) !== key) continue;
		const day = Number(item.day.slice(8, 10));
		const list = byDay.get(day);
		if (list) list.push(item);
		else byDay.set(day, [item]);
	}

	const cells: JournalCell[] = [];
	for (let i = 0; i < weekRows(key) * 7; i++) {
		const date = i - first + 1;
		if (date < 1 || date > days) {
			cells.push({ outside: true, date: 0, marks: [], minutes: 0, tracks: [], scale: 1 });
			continue;
		}
		const day = (byDay.get(date) ?? [])
			.slice()
			// Biggest first, then by track so a tie between a film and a meal
			// doesn't depend on which query came back first.
			.sort((a, b) => b.minutes - a.minutes || a.track.localeCompare(b.track) || a.key.localeCompare(b.key));
		const present = new Set(day.map((d) => d.track));
		const marks = day.map(toMark);
		cells.push({
			outside: false,
			date,
			marks,
			scale: clusterScale(marks),
			minutes: day.reduce((total, d) => total + d.minutes, 0),
			tracks: TRACKS.filter((t) => present.has(t.id)).map((t) => t.id),
		});
	}
	return cells;
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface SummaryStat {
	label: string;
	value: string;
}

const hours = (minutes: number) => `${Math.round(minutes / 60)}h`;

/**
 * One figure per track: the hours it took. Counts, not hours, is the tempting
 * alternative — but this whole card is drawn in minutes, and a summary in a
 * different unit than the picture above it would be reading the same month off
 * two scales. Hours also let the four sit next to each other honestly: nine
 * meals and nine films are not the same month.
 */
export function summarise(items: JournalItem[]): SummaryStat[] {
	return TRACKS.map((track) => ({
		label: track.label,
		value: hours(
			items.reduce((total, i) => (i.track === track.id ? total + i.minutes : total), 0),
		),
	}));
}

/** Days with at least one item, and total hours — the card's headline pair. */
export function headline(items: JournalItem[]): { days: number; hours: string } {
	return {
		days: new Set(items.map((i) => i.day)).size,
		hours: hours(items.reduce((total, i) => total + i.minutes, 0)),
	};
}

/** The 24x24 glyph for an activity's sport, and its label. Thin re-export so
 *  the page has one import for the card. */
export function sportMark(sport: string): { icon: string; label: string } {
	return { icon: sportIcon(sport), label: sportMeta(sport).label };
}
