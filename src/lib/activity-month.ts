// "The month in activities" — the fourth share card in the family, and the one
// with an opinion the other three don't share.
//
// THE RULE THIS CARD IS BUILT AROUND. The film card stacks a day's watches and
// shows the best one on top — but every print in the stack is still there,
// fanned out behind it, and the count badge tells you how many. This card does
// something stricter: it sorts a day's activities by `exertion` and draws only
// the largest. A day with a commute spin, a pool swim and a five-hour ride
// shows the ride — full stop. The commute and the swim are not faded or
// stacked behind it; they exist only in the hover tooltip.
//
// WHY. The landing page (`/activities`) is a record you read — every activity,
// every day, because a log's whole job is to not lose anything. This card is a
// picture you post — one image, once, and an image has room for one true thing
// per day. Averaging the day (mean exertion, total distance) would answer a
// question nobody standing in front of the calendar is asking; showing every
// activity at survivable size would draw the ride so small its route is
// meaningless. Sorting by what asked the most of the body and showing that one
// is the same editorial move a training log's own athlete makes when a friend
// asks "what did you do that day" — they don't recite the commute, they say
// "I did the five-hour ride." A rejected alternative: sort by distance or
// duration, the way the film card sorts by rating. Neither is comparable across
// sports (a 5k swim and a 5-mile hike aren't "bigger" by metres), which is
// exactly the gap ACTIVITIES.md §3 built `exertion` to close — it is this
// section's only honest answer to "which of today's activities was the one."
//
// The calendar arithmetic and the artboard are shared with the film and
// reading cards and live in share-card.ts; this file re-exports what the page
// needs. What's genuinely this card's own — the dominance rule, the per-cell
// face (route stroke or sport glyph), and the four summary figures — is here.

import type { ActivityListRow } from './activities';
import { ALPINE, exertionInk, type AlpineColor } from './activity-tokens';
import { formatStat, sportIcon, sportMeta, type StatKey } from './sports';
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
	monthQuery,
	parseMonthKey,
	shiftMonth,
	weekRows,
	type Aspect,
	type Geometry,
} from './share-card';

/**
 * One activity as the card needs it — a narrow slice of `ActivityListRow`
 * (activities.ts, the Schema track), kept to exactly the fields the dominance
 * sort, the headline stat and the route face read. `ActivityListRow` already
 * satisfies this shape structurally, so `listActivitiesForMonth`'s rows pass
 * straight in without a mapping step.
 */
export interface MonthActivity {
	id: number;
	sport: string;
	title: string;
	local_date: string;
	distance_m: number | null;
	moving_seconds: number | null;
	elapsed_seconds: number;
	elevation_gain_m: number | null;
	avg_power_w: number | null;
	avg_hr: number | null;
	avg_speed_ms: number | null;
	work_kj: number | null;
	exertion: number | null;
	route_path: string | null;
}

/**
 * A day's activities, largest exertion first. Nulls sort last — an
 * un-scored activity never wins over a scored one, but if nothing that day
 * has a score, the day still needs a winner, so the tie-break below decides
 * it instead of leaving the day blank.
 *
 * Ties (including "everyone is null") break on `moving_seconds` — the
 * longer effort is the more defensible "main event" absent any other
 * signal — and then on `id`, so a day that ties all the way down still
 * renders identically on every load rather than depending on fetch order.
 */
export function sortByExertion(activities: MonthActivity[]): MonthActivity[] {
	return activities.slice().sort((a, b) => {
		const ae = a.exertion ?? -1;
		const be = b.exertion ?? -1;
		if (ae !== be) return be - ae;
		const am = a.moving_seconds ?? -1;
		const bm = b.moving_seconds ?? -1;
		if (am !== bm) return bm - am;
		return a.id - b.id;
	});
}

/** The one activity a day is drawn from — see the header comment for why
 *  there is only one. `null` for a day with nothing logged. */
export function dominantActivity(activities: MonthActivity[]): MonthActivity | null {
	if (activities.length === 0) return null;
	return sortByExertion(activities)[0];
}

// ---------------------------------------------------------------------------
// The per-cell face — route stroke, or sport glyph + one headline figure.
// Same two-faces-by-design rule as ActivityCard.astro (ACTIVITIES.md §7): a
// cell with no GPS does not apologise for the blank map, it gives its whole
// face to the number the workout does have.
// ---------------------------------------------------------------------------

/** Stat keys `MonthActivity`'s narrow shape can actually compute — a filter
 *  over `sportMeta().primaryStats` so a sport whose lead stat needs a column
 *  this card didn't fetch (SWOLF, pool length, vertical descent) falls
 *  through to one this shape does carry, rather than rendering "—". */
const COMPUTABLE_STATS: ReadonlySet<StatKey> = new Set([
	'distance',
	'moving_time',
	'elapsed_time',
	'elevation_gain',
	'avg_power',
	'avg_speed',
	'avg_hr',
	'work_kj',
]);

/**
 * The one figure a no-route cell leads with: the first of the sport's own
 * `primaryStats` (its considered opinion of what that sport is about) that
 * this card can compute and that the activity actually has a value for.
 * Exertion is skipped here — it already speaks through the cell's ink, so
 * repeating it as the headline number would be the same fact said twice.
 * Falls back to moving (then elapsed) time, which every logged activity has.
 */
export function headlineStat(a: MonthActivity): { label: string; value: string } {
	const meta = sportMeta(a.sport);
	for (const key of meta.primaryStats) {
		if (key === 'exertion' || !COMPUTABLE_STATS.has(key)) continue;
		const stat = formatStat(key, a);
		if (stat.value !== '—') return stat;
	}
	const moving = formatStat('moving_time', a);
	return moving.value !== '—' ? moving : formatStat('elapsed_time', a);
}

/** The 24x24 glyph path for a no-route cell's sport mark. Thin re-export so
 *  the page has one place to reach for both the icon and the stat. */
export function cellIcon(a: MonthActivity): string {
	return sportIcon(a.sport);
}

/** The colour exertion drives the cell's face at — a hard month should read
 *  hard at a glance, the one thing this card can say that a list can't. */
export function cellInk(a: MonthActivity | null): AlpineColor {
	return exertionInk(a?.exertion);
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** One line per activity that day, dominant first — what the hover tooltip
 *  shows so the activities the face doesn't draw are still discoverable.
 *  Hiding them from the image is a layout decision, not a claim they didn't
 *  happen (see the header comment). */
function lineFor(a: MonthActivity): string {
	const stat = headlineStat(a);
	const exertion = a.exertion != null ? `${Math.round(a.exertion)} exertion` : sportMeta(a.sport).label;
	return `${a.title} · ${stat.value} · ${exertion}`;
}

export interface MonthCell {
	/** A padding cell before the 1st or after the last — drawn as nothing. */
	outside: boolean;
	date: number;
	/** The day's dominant activity (highest exertion), or null on a rest day. */
	activity: MonthActivity | null;
	/** The true count of that day's activities, even though only one is drawn. */
	count: number;
	/** Every activity that day, dominant first, for the hover tooltip. */
	lines: string[];
}

/** The month's cells, in reading order, padded out to whole weeks — mirrors
 *  month-view.ts's `buildCells` and reading-month-view.ts's, one row per
 *  calendar day rather than per activity. */
export function buildCells(key: string, activities: MonthActivity[]): MonthCell[] {
	const parsed = parseMonthKey(key);
	if (!parsed) return [];
	const { year, month } = parsed;
	const days = daysInMonth(year, month);
	const first = firstWeekdayIndex(year, month);

	const byDay = new Map<number, MonthActivity[]>();
	for (const a of activities) {
		const day = Number(a.local_date.slice(8, 10));
		const list = byDay.get(day);
		if (list) list.push(a);
		else byDay.set(day, [a]);
	}

	const cells: MonthCell[] = [];
	for (let i = 0; i < weekRows(key) * 7; i++) {
		const date = i - first + 1;
		if (date < 1 || date > days) {
			cells.push({ outside: true, date: 0, activity: null, count: 0, lines: [] });
			continue;
		}
		const day = sortByExertion(byDay.get(date) ?? []);
		cells.push({
			outside: false,
			date,
			activity: day[0] ?? null,
			count: day.length,
			lines: day.map(lineFor),
		});
	}
	return cells;
}

// ---------------------------------------------------------------------------
// Geometry — mirrors month-view.ts's / reading-month-view.ts's: only the tall
// (Story) aspect has the vertical room for the summary band, so the other two
// give that space back to the grid, where forty cells' worth of route lines
// are worth more than four extra numbers.
// ---------------------------------------------------------------------------

/**
 * Vertical space the header, summary and footer take, measured against this
 * card's own CSS at 1080 wide (padding 44/46/40, a two-line header, the
 * weekday row, the footer rule, and — when present — the summary band).
 * Kept in lockstep with the stylesheet below by hand, the same contract
 * month-view.ts's and reading-month-view.ts's constants keep.
 */
const CHROME_WITH_FIGURES = 460;
const CHROME_BARE = 300;

export interface ActivityGeometry extends Geometry {
	/** Whether the summary band is drawn at this aspect. */
	figures: boolean;
}

export function hasFigures(aspect: Aspect): boolean {
	return aspect.id === '9:16';
}

/** Geometry for every aspect, keyed by id — the aspect toggle just swaps these in. */
export function geometries(rows: number): Record<string, ActivityGeometry> {
	const out: Record<string, ActivityGeometry> = {};
	for (const aspect of ASPECTS) {
		const figures = hasFigures(aspect);
		out[aspect.id] = {
			...cardGeometry(rows, aspect.height, figures ? CHROME_WITH_FIGURES : CHROME_BARE),
			figures,
		};
	}
	return out;
}

// ---------------------------------------------------------------------------
// The summary band
// ---------------------------------------------------------------------------

export interface SummaryStat {
	label: string;
	value: string;
}

/**
 * The four figures under the grid: total distance, total elevation gain,
 * total moving time, total exertion.
 *
 * WHY THESE FOUR AND NOT DAYS-ACTIVE OR STREAK. Both of those are already
 * legible from the grid itself — count the filled cells, count the longest
 * run of them — so printing them again under the calendar would spend the
 * summary band restating what the picture above it already shows. Distance,
 * elevation, moving time and exertion are the opposite: no amount of staring
 * at forty route sketches tells you the month added up to 340 miles or
 * 41,000 feet of climbing, because a route poster is drawn to a fixed
 * viewBox and throws its own scale away on purpose (route-shape.ts). These
 * four are sums a picture cannot make honest on its own, which is exactly
 * why they earn a line of type. Exertion in particular is the one number
 * that speaks for the *whole* month the way no single stat can — the same
 * reason `exertion` exists at all (ACTIVITIES.md §3) is the reason its total
 * belongs here.
 */
export function summarise(key: string, activities: MonthActivity[]): SummaryStat[] {
	const distanceM = activities.reduce((total, a) => total + (a.distance_m ?? 0), 0);
	const elevationM = activities.reduce((total, a) => total + (a.elevation_gain_m ?? 0), 0);
	const movingS = activities.reduce((total, a) => total + (a.moving_seconds ?? a.elapsed_seconds ?? 0), 0);
	const exertion = activities.reduce((total, a) => total + (a.exertion ?? 0), 0);
	return [
		{ label: 'Distance', value: formatStat('distance', { distance_m: distanceM }).value },
		{ label: 'Elevation', value: formatStat('elevation_gain', { elevation_gain_m: elevationM }).value },
		{ label: 'Moving time', value: formatStat('moving_time', { moving_seconds: movingS }).value },
		{ label: 'Exertion', value: Math.round(exertion).toLocaleString('en-US') },
	];
}

/** The longest run of consecutive days with at least one activity, within the month. */
export function longestStreak(key: string, activities: MonthActivity[]): number {
	return runOfDays(
		key,
		activities.map((a) => a.local_date),
	);
}

/** ALPINE re-exported so the page has one import for tokens + card logic. */
export { ALPINE };
