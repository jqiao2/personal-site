// The hour histogram, as pure functions — twenty-four bars over one local day.
//
// One component, two scopes. The month card draws it at `mini` on the artboard,
// where it is part of the exported image and so has no hover and no toggle; the
// book page draws it at `lg`, closed until asked for, with a tooltip.
//
// The axis is a plain 0→23 clock and stays one. Most of this reading happens
// after midnight, which on a real clock means the tall bars sit at both ends
// with a hollow middle — that is the shape of the habit, not a fault to be
// rotated away. Merging the small hours into a single "night" would hide the
// one thing the chart exists to show, which is that 1am and 2am are different.

/** A bar's fill, by how tall it is relative to the day's biggest hour. */
const RAMP = [
	'#241a10',
	'rgba(207,164,82,.26)',
	'rgba(207,164,82,.48)',
	'rgba(207,164,82,.74)',
	'#cfa452',
] as const;

export const HOURS_IN_DAY = 24;

/**
 * Occupied hours needed before there is a distribution to draw.
 *
 * Two bars is not a shape, it is two facts, and drawing them as a chart implies
 * a pattern that a single evening cannot support. Under this the fallback line
 * says which hours they were, in words.
 */
export const MIN_OCCUPIED_HOURS = 3;

export type HourSize = 'mini' | 'sm' | 'lg';

interface Geom {
	/** Plot height in px. */
	H: number;
	gap: number;
	/** Which hours get a label under the axis. */
	labels: number[];
	/** Label font size in px. */
	type: number;
	/** Whether this size carries a tooltip. The card, being an image, does not. */
	chrome: boolean;
}

const SIZES: Record<HourSize, Geom> = {
	mini: { H: 40, gap: 1.5, labels: [0, 6, 12, 18], type: 9, chrome: false },
	sm: { H: 76, gap: 2, labels: [0, 12, 18], type: 10, chrome: true },
	lg: { H: 104, gap: 3.5, labels: [0, 6, 12, 18], type: 10, chrome: true },
};

export function geometry(size: HourSize, scale = 1): Geom {
	const g = SIZES[size];
	return {
		...g,
		H: Math.round(g.H * scale),
		gap: Number((g.gap * scale).toFixed(2)),
		type: Number((g.type * scale).toFixed(1)),
	};
}

/** "midnight", "noon", "2am" — the compact form, for under the axis. */
export function axisLabel(hour: number): string {
	if (hour === 0) return 'midnight';
	if (hour === 12) return 'noon';
	return `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? 'am' : 'pm'}`;
}

/** "midnight", "noon", "2 am" — the spoken form, for the tooltip and prose. */
export function clockLabel(hour: number): string {
	if (hour === 0) return 'midnight';
	if (hour === 12) return 'noon';
	return `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? ' am' : ' pm'}`;
}

/**
 * What stands in for the chart when there isn't enough of a day to draw one.
 *
 * Names the hours rather than apologising: "Only 11 pm and midnight" is a fact
 * about the book, and a more useful one than an empty chart would have been.
 */
export function tooFewLine(hours: number[]): string {
	const on: number[] = [];
	hours.forEach((v, h) => {
		if (v > 0) on.push(h);
	});
	if (on.length === 0) return 'No page turns with a usable time on them.';
	return `Only ${on.map(clockLabel).join(' and ')} — not enough of a day to draw one.`;
}

export interface HourColumn {
	hour: number;
	pages: number;
	/** 0 for an empty hour, then 1–4 up the gold ramp. */
	level: number;
	/** Bar height in px. An empty hour keeps a 2px stub so the axis reads as full. */
	height: number;
	background: string;
	radius: string;
	/** The tooltip's whole sentence, precomputed — the client only positions it. */
	tip: string;
}

export interface HourAxisLabel {
	text: string;
	/** Percent from the left edge of the plot. */
	left: number;
	/** translateX, pulled in at the ends so the first and last labels stay inside. */
	shift: string;
}

export interface HourHistogram {
	size: HourSize;
	geom: Geom;
	columns: HourColumn[];
	labels: HourAxisLabel[];
	total: number;
	occupied: number;
	/** Whether there is enough of a day to draw. False means show `fallback`. */
	enough: boolean;
	fallback: string;
}

export interface HourInput {
	/** 24 page-turn counts, midnight first. Short or long arrays are normalised. */
	hours: number[];
	size: HourSize;
	scale?: number;
	/** "this book" or "the month" — the tail of "34% of …". */
	scopeWord: string;
	/** Per-hour count of the sittings or days that touched it, for the tooltip. */
	spread?: number[] | null;
	spreadTotal?: number;
	spreadUnit?: string;
	/** Overrides the default "not enough of a day" line. */
	fallback?: string;
}

/** Centre of hour `i`'s column, as a percentage of the plot's width. */
function centre(index: number): number {
	return (index / HOURS_IN_DAY) * 100 + 100 / (HOURS_IN_DAY * 2);
}

export function buildHistogram(input: HourInput): HourHistogram {
	const size = input.size;
	const geom = geometry(size, input.scale ?? 1);
	const hours = Array.from({ length: HOURS_IN_DAY }, (_, h) => Math.max(0, input.hours[h] ?? 0));

	const total = hours.reduce((sum, v) => sum + v, 0);
	const occupied = hours.filter((v) => v > 0).length;
	// Guard the divisor: an all-zero day would otherwise make every ratio NaN.
	const max = Math.max(1, ...hours);

	const columns: HourColumn[] = hours.map((pages, hour) => {
		const ratio = pages / max;
		const level = !pages ? 0 : ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
		return {
			hour,
			pages,
			level,
			// A real hour never draws thinner than 3px — below that a bar reads as
			// the empty stub beside it and the chart lies about a page being turned.
			height: pages ? Math.max(3, Math.round(ratio * geom.H)) : 2,
			background: RAMP[level],
			radius: pages ? '2px 2px 0 0' : '1px',
			tip: tipFor(hour, pages, total, input),
		};
	});

	const labels: HourAxisLabel[] = geom.labels.map((hour) => {
		const left = centre(hour);
		return {
			text: axisLabel(hour),
			left,
			shift: left < 8 ? '-8%' : left > 92 ? '-92%' : '-50%',
		};
	});

	return {
		size,
		geom,
		columns,
		labels,
		total,
		occupied,
		enough: occupied >= MIN_OCCUPIED_HOURS,
		fallback: input.fallback || tooFewLine(hours),
	};
}

/**
 * One hour's tooltip: what was read, what share of the whole it was, and how
 * much of the reading it was spread across.
 *
 * The share is what stops a tall bar being read as "a lot" in isolation, and the
 * spread is what stops it being read as a habit when it was really one long
 * night: "250 pages · 34% of this book · 2 of 20 sittings" says both at once.
 */
function tipFor(hour: number, pages: number, total: number, input: HourInput): string {
	if (!pages) return `${clockLabel(hour)} — nothing read`;
	const pct = Math.round((pages / total) * 100);
	const touched = input.spread?.[hour] ?? 0;
	const spread =
		touched && input.spreadTotal
			? ` · ${touched} of ${input.spreadTotal} ${input.spreadUnit ?? 'sittings'}`
			: '';
	return (
		`${clockLabel(hour)} — ${pages.toLocaleString('en-US')} ${pages === 1 ? 'page' : 'pages'}` +
		` · ${pct < 1 ? '<1' : pct}% of ${input.scopeWord}${spread}`
	);
}
