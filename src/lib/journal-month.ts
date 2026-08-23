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
 * `MARK_K` is set so a typical feature film (105 min) draws at ~66px on its
 * long side, which is half again the width of the ~128px cell it sits in. That
 * is deliberate: a mark is allowed to spill onto its neighbours (see
 * `dayLayer`), so the size that reads best is the one a Polaroid actually is
 * relative to a page's daily square, not the largest one that would fit inside
 * the lines.
 *
 * `MARK_MIN` is the floor at which a mark is still a picture of something
 * rather than a dot. `MARK_MAX` caps the marathon days: past ~4½ hours the
 * mark has already said "this was the day", and a bigger one just buries the
 * week around it.
 *
 *   20 min → 29px    60 min → 50px    105 min → 66px
 *   180 min → 86px   270+ min → 104px (capped)
 */
export const MARK_K = 6.4;
export const MARK_MIN = 26;
export const MARK_MAX = 104;

/** A mark's nominal side, in artboard px, for `minutes` spent on it. This is
 *  the side of the SQUARE the mark's area has to fill; `markBox` spends that
 *  area at the mark's real aspect ratio. */
export function markSize(minutes: number): number {
	const side = MARK_K * Math.sqrt(Math.max(0, minutes));
	return Math.round(Math.min(MARK_MAX, Math.max(MARK_MIN, side)));
}

/**
 * How far from square a mark is allowed to get.
 *
 * A photograph is whatever shape it was taken in, and a panorama at its true
 * ratio would come out as a 260px splinter twelve pixels tall — technically the
 * right area, useless as a picture. Clamping keeps every mark recognisable as
 * an object stuck to a page. Posters (2:3) and covers sit well inside it.
 */
export const ASPECT_MIN = 0.55;
export const ASPECT_MAX = 1.8;

/** TMDB posters are uniformly 2:3, and Open Library covers are near enough to
 *  it that assuming so is better than drawing them square. */
export const PRINT_ASPECT = 2 / 3;

export interface MarkBox {
	w: number;
	h: number;
}

/**
 * A mark's real width and height: `size`² of area, spent at aspect ratio
 * `aspect` (width ÷ height).
 *
 * AREA IS THE INVARIANT, NOT THE SIDE. A poster and a square photograph
 * standing for the same two hours must cover the same amount of paper, or the
 * card stops meaning what it says — so the box is w = size·√aspect,
 * h = size/√aspect, whose product is size² whatever the shape.
 */
export function markBox(size: number, aspect: number): MarkBox {
	const a = Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, aspect || 1));
	const root = Math.sqrt(a);
	return { w: Math.round(size * root), h: Math.round(size / root) };
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
	/** Width ÷ height of whatever the mark draws, so the box can be cut to the
	 *  real shape of the thing rather than cropped square. */
	aspect: number;
	/** A route as an `M x y L …` path on a 0 0 100 100 viewBox — an activity's
	 *  face when it has GPS. */
	route: string | null;
	/** A 24x24 glyph path. An activity with no route falls back to it; nothing
	 *  else has one. */
	icon: string | null;
	/** Where the mark links to, if that thing has a page of its own. */
	href: string | null;
}

export interface JournalMark extends JournalItem {
	/** Side of the square the mark's area fills — see `markSize`. */
	size: number;
	/** The box that area is actually spent on, at the mark's aspect ratio. */
	box: MarkBox;
	/** Degrees of tilt — pinned to `key`, small, and never zero, so a cluster
	 *  looks stuck in by hand rather than laid out. */
	tilt: number;
	/** Offset from the centre of the day's square, in artboard px. Set by
	 *  `placeCluster`, which needs the whole day, so it is 0,0 until then. */
	dx: number;
	dy: number;
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
	const size = markSize(item.minutes);
	return { ...item, size, box: markBox(size, item.aspect), tilt, dx: 0, dy: 0 };
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
		aspect: PRINT_ASPECT,
		route: null,
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
			aspect: PRINT_ASPECT,
			route: null,
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
	photos?: { url: string; width: number | null; height: number | null }[];
}

export function mealItems(visits: VisitRow[]): JournalItem[] {
	return visits.map((v) => {
		const snack = isSnack(v);
		const photo = v.photos?.[0];
		return {
			track: 'meal' as const,
			key: String(v.id),
			day: v.visited_on,
			minutes: snack ? SNACK_MINUTES : MEAL_MINUTES,
			title: v.restaurant_name,
			detail: v.cuisines?.join(' · ') || v.neighborhood || (snack ? 'Snack' : 'Meal'),
			image: photo ? photoSrc(photo.url, 320) : null,
			// The photograph's own shape, when the row recorded it. A plate shot
			// with no dimensions falls back to square rather than guessing
			// landscape — a square is wrong in one direction, a guess in two.
			aspect: photo?.width && photo?.height ? photo.width / photo.height : 1,
			route: null,
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
	route_path: string | null;
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
		// A route is fitted to a square viewBox by route-shape.ts, so it spends
		// its area square whatever shape the ride was.
		aspect: 1,
		route: a.route_path,
		// The glyph is the fallback, not the face: a pool swim, a trainer ride
		// and a treadmill run have no GPS at all, and that is normal rather than
		// missing (ACTIVITIES.md's second bullet).
		icon: a.route_path ? null : sportIcon(a.sport),
		href: `/activities/${a.id}`,
	}));
}

// ---------------------------------------------------------------------------
// The pile
// ---------------------------------------------------------------------------

/**
 * How the day's prints are scattered.
 *
 * WHY NOT JUST WRAP THEM. The first version let the marks flow left to right
 * and wrap, which is what a text layout does — and it looks like one: a row,
 * then another row under it, every cluster reading as a line of things rather
 * than a handful. It also wastes the square. A day is roughly 128 x 180px and a
 * row only ever uses the top of it, so the marks had to stay small enough to
 * queue up, which is the opposite of what this card wants.
 *
 * SO THEY GET REAL POSITIONS. Each print is placed at an angle and a distance
 * from the middle of the day. The angles walk by the golden angle (137.5°),
 * which is how a sunflower packs seeds — consecutive marks land nowhere near
 * each other, and nothing clumps on one side the way stepping by a round
 * fraction of a turn would. The distance grows as √i, which is what keeps the
 * density even as the pile gets bigger rather than leaving a hole in the
 * middle or a ring around the outside.
 *
 * THE BIGGEST PRINT IS AT THE CENTRE, because the marks arrive sorted biggest
 * first and the first one gets distance zero. That is also the right editorial
 * answer: the thing that took the most of the day anchors it and the rest are
 * scattered over it.
 *
 * AND THEN IT'S KNOCKED OFF THE PATTERN. A perfect phyllotaxis is legible as a
 * pattern, which is its own kind of wrong — so each mark's angle and distance
 * are jittered by its own hash. Same input, same pile, every render; nothing on
 * a grid.
 */

/** 137.5°, in radians — the angle a sunflower steps by. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * The knobs, and what each one does if you turn it.
 *
 * `PACK` — how far apart the prints sit, as a multiple of their own mean size.
 * Bigger spreads the pile out and lets more of it fall on the neighbouring
 * days; smaller buries the marks in each other. 0.52 puts a five-print day at
 * about a print's width from the middle.
 *
 * `SPREAD_X` / `SPREAD_Y` — the pile is an ellipse, not a circle, because a
 * day's square isn't square: ~128px across and ~180px down. Spreading wider
 * than tall would push prints onto the day either side, which are the days a
 * reader is most likely to confuse them with; spilling up and down lands them
 * on the week above and below, which is further away in every sense.
 *
 * `SPACING_FLOOR` — the smallest print size the spacing may be computed from.
 * Without it a day of seven small things (two chapters, a coffee, a snack)
 * scatters over 85 x 94px and leaves most of its square empty, because the
 * spacing is derived from the prints and the prints are tiny. The day is still
 * a whole day and still owns its square, so the pile gets a minimum spread
 * whatever it happens to be made of.
 */
export const PACK = 0.52;
export const SPACING_FLOOR = 46;
export const SPREAD_X = 0.82;
export const SPREAD_Y = 1.18;

/**
 * The day's marks with their offsets filled in. Pure, and stable: the jitter
 * comes from each mark's own key, so a reload doesn't reshuffle the pile.
 */
export function placeCluster(marks: JournalMark[]): JournalMark[] {
	if (marks.length <= 1) return marks;
	// Spacing scales with the prints themselves, so a day of long films spreads
	// further than a day of snacks rather than both using one fixed radius.
	const mean = Math.max(
		SPACING_FLOOR,
		marks.reduce((total, m) => total + (m.box.w + m.box.h) / 2, 0) / marks.length,
	);
	return marks.map((mark, i) => {
		if (i === 0) return mark;
		const h = hash(`${mark.track}:${mark.key}:place`);
		// ±0.5 rad off the golden step, and ±15% on the distance.
		const angle = i * GOLDEN_ANGLE + ((h % 100) / 100 - 0.5);
		const radius = PACK * mean * Math.sqrt(i) * (0.85 + ((h >> 7) % 100) / 100 / 3.33);
		return {
			...mark,
			dx: Math.round(radius * Math.cos(angle) * SPREAD_X),
			dy: Math.round(radius * Math.sin(angle) * SPREAD_Y),
		};
	});
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
	/** Paint order for the day's spill — see `dayLayer`. */
	layer: number;
}

/**
 * Which day paints on top where two days' marks overlap.
 *
 * MARKS ARE ALLOWED OUT OF THEIR SQUARE. A cell is ~128px wide and a good
 * Saturday is bigger than that, so the marks spill onto the days around them —
 * which is what a page of a real journal looks like once you have stuck things
 * to it. Sizing every mark down to fit inside the ruled box would trade the one
 * thing this card is for (an honest picture of how much of the day a thing
 * took) for tidiness.
 *
 * Spill needs a paint order, and the order is chronological: a later day sits
 * on top of an earlier one, because that is the order the things were stuck
 * in. It follows that a big Saturday can cover Friday's date numeral, and that
 * is fine — you can still read the date off the column and the row.
 */
export function dayLayer(date: number): number {
	return date;
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
			cells.push({ outside: true, date: 0, marks: [], minutes: 0, tracks: [], layer: 0 });
			continue;
		}
		const day = (byDay.get(date) ?? [])
			.slice()
			// Biggest first, then by track so a tie between a film and a meal
			// doesn't depend on which query came back first.
			.sort((a, b) => b.minutes - a.minutes || a.track.localeCompare(b.track) || a.key.localeCompare(b.key));
		const present = new Set(day.map((d) => d.track));
		const marks = placeCluster(day.map(toMark));
		cells.push({
			outside: false,
			date,
			marks,
			layer: dayLayer(date),
			minutes: day.reduce((total, d) => total + d.minutes, 0),
			tracks: TRACKS.filter((t) => present.has(t.id)).map((t) => t.id),
		});
	}
	return cells;
}
