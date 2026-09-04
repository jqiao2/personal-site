// The fitness trend — the Performance Management Chart, from daily training
// load. Pure: loads in, curves and plot geometry out, no DB client, so the
// page renders the initial 6-month view server-side and the client script
// redraws the same shape when the timeframe changes — one implementation, not
// two that drift (the same split as src/lib/athlete.ts).
//
// THE MODEL. Bannister's impulse-response, as TrainingPeaks' PMC popularised
// it. Each day carries a training load; this site already computes one per
// activity — `exertion`, a TSS-equivalent where an hour at threshold scores
// 100 (ACTIVITIES.md §3) — so a day's load is the sum of its activities'
// exertion, and a rest day is a real zero that decays the averages.
//
//   Fitness (CTL) = exponentially-weighted moving average of daily load,
//                   42-day time constant. What the body has banked; slow.
//   Fatigue (ATL) = the same average, 7-day constant. The recent cost; fast.
//   Form    (TSB) = yesterday's Fitness − yesterday's Fatigue. The balance you
//                   START a day with — positive is fresh, negative is buried.
//
// TSB is YESTERDAY's, not today's, per the TrainingPeaks convention: form is
// what you bring into a day, before that day's session lands on it.
//
// SEED FROM THE VERY FIRST DAY. CTL needs ~42 days of history behind it to be
// right, so the curve is always computed over the whole history from the first
// activity and only then sliced to the requested window — the 6-month view's
// opening Fitness is a real number, not a ramp from zero.

export interface Load {
	/** 'YYYY-MM-DD', the local calendar day. */
	date: string;
	/** That day's summed exertion. 0 for a rest day. */
	load: number;
}

export interface PmcPoint {
	date: string;
	/** Fitness (CTL). */
	ctl: number;
	/** Fatigue (ATL). */
	atl: number;
	/** Form (TSB) — yesterday's ctl − atl. */
	tsb: number;
}

/** EWMA time constants, in days. The PMC's canonical 42 / 7. */
export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' + n days, as a string — no UTC-shifting Date round-trip (wiki
 *  pattern 0005: a bare `new Date('2026-01-01')` is midnight UTC and drifts a
 *  day west of here). */
export function addDay(date: string, n: number): string {
	const [y, m, d] = date.split('-').map(Number);
	const dt = new Date(y, (m || 1) - 1, d || 1);
	dt.setDate(dt.getDate() + n);
	return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The full daily Fitness/Fatigue/Form curve, from the first load-bearing day
 * through `today` inclusive — one point per calendar day, gaps filled with
 * zero-load rest days so the averages decay across them. `loads` need not be
 * sorted or gap-free; anything on or before `today` is used and later dates are
 * ignored. `[]` when there's nothing to draw.
 */
export function computePmc(loads: Load[], today: string): PmcPoint[] {
	const byDate = new Map<string, number>();
	for (const l of loads) {
		if (l.date <= today) byDate.set(l.date, (byDate.get(l.date) ?? 0) + l.load);
	}
	if (byDate.size === 0) return [];

	const start = [...byDate.keys()].reduce((a, b) => (a < b ? a : b));
	// α = 1 − e^(−1/τ): the exact daily decay for a τ-day time constant, not the
	// 1/τ linear approximation — same length, closer to the impulse response.
	const aCtl = 1 - Math.exp(-1 / CTL_DAYS);
	const aAtl = 1 - Math.exp(-1 / ATL_DAYS);

	const out: PmcPoint[] = [];
	let ctl = 0;
	let atl = 0;
	for (let date = start; date <= today; date = addDay(date, 1)) {
		// Form is measured BEFORE today's load lands — it's yesterday's balance.
		const tsb = ctl - atl;
		const load = byDate.get(date) ?? 0;
		ctl += aCtl * (load - ctl);
		atl += aAtl * (load - atl);
		out.push({ date, ctl: round1(ctl), atl: round1(atl), tsb: round1(tsb) });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Windowing + plot geometry. A wide line chart (no dots — a daily series is far
// too dense for them), so it renders at a fixed viewBox and scales to width
// uniformly; nothing is stretched, which is what keeps a chart honest (wiki
// pattern 0012).
// ---------------------------------------------------------------------------

/** Preset timeframes, in toggle order. `days: null` is "all". Six months is the
 *  default — the window in which training actually moved, same call as the
 *  athlete page. A custom from/to overrides these entirely. */
export const RANGES = [
	{ key: '3m', label: '3M', days: 90 },
	{ key: '6m', label: '6M', days: 182 },
	{ key: '1y', label: '1Y', days: 365 },
	{ key: 'all', label: 'All', days: null },
] as const;

export type RangeKey = (typeof RANGES)[number]['key'];
export const DEFAULT_RANGE: RangeKey = '6m';

/** The inclusive [from, to] a preset resolves to, ending `today`. `null` from =
 *  the whole series. */
export function rangeDates(range: RangeKey, today: string): { from: string | null; to: string } {
	const days = RANGES.find((r) => r.key === range)?.days ?? null;
	return { from: days == null ? null : addDay(today, -days), to: today };
}

/** The slice of the curve inside [from, to] inclusive; a null bound is open.
 *  Never falls back the way athlete's `windowed` does — the fitness curve is
 *  daily and dense, so a window always has points unless it sits entirely
 *  outside the data, in which case an empty slice is the honest answer. */
export function windowPmc(points: PmcPoint[], from: string | null, to: string | null): PmcPoint[] {
	return points.filter((p) => (from == null || p.date >= from) && (to == null || p.date <= to));
}

/** The plot box. Uniform-scaled to the card width — see the module note. The
 *  left/bottom padding leaves room for the y labels and the month axis. */
export const PLOT_W = 720;
export const PLOT_H = 240;
const PAD_L = 30;
const PAD_R = 6;
const PAD_T = 12;
const PAD_B = 18;

export interface FitnessPlot {
	/** Polyline `points` strings for the two lines. */
	ctlLine: string;
	atlLine: string;
	/** Closed area path for Form, filled between the line and the zero baseline. */
	tsbArea: string;
	/** The Form line itself, drawn over its fill. */
	tsbLine: string;
	/** y of the Form baseline (value 0), for the dashed zero rule. */
	zeroY: number;
	/** Axis extent actually drawn against. */
	lo: number;
	hi: number;
	/** Horizontal gridlines: a y and its value label. */
	yTicks: { y: number; value: number }[];
	/** Month boundaries inside the window: an x and its label. */
	xTicks: { x: number; label: string }[];
	/** The most recent point — the header's current Fitness/Fatigue/Form. */
	last: PmcPoint;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A "nice" step (1/2/5 × 10ⁿ) near `target`, for the y gridlines. */
function niceStep(target: number): number {
	if (target <= 0) return 1;
	const pow = Math.pow(10, Math.floor(Math.log10(target)));
	const n = target / pow;
	const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
	return step * pow;
}

/**
 * Turn a windowed curve into everything the SVG needs. One shared y-axis for
 * all three series: Fitness and Fatigue are the same quantity (a training load)
 * and their GAP is Form, so plotting them together is the whole point — Form
 * then rides the same axis with a zero baseline so its sign reads directly.
 * `null` when the window is empty.
 */
export function plotPmc(points: PmcPoint[]): FitnessPlot | null {
	if (points.length === 0) return null;

	let hi = 0;
	let lo = 0;
	for (const p of points) {
		hi = Math.max(hi, p.ctl, p.atl, p.tsb);
		lo = Math.min(lo, p.tsb); // only Form goes negative
	}
	if (hi === lo) hi = lo + 1; // a dead-flat all-zero window still has an axis

	const innerW = PLOT_W - PAD_L - PAD_R;
	const innerH = PLOT_H - PAD_T - PAD_B;
	const n = points.length;
	const x = (i: number) => PAD_L + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
	const y = (v: number) => PAD_T + ((hi - v) / (hi - lo)) * innerH;

	const line = (read: (p: PmcPoint) => number) =>
		points.map((p, i) => `${x(i).toFixed(1)},${y(read(p)).toFixed(1)}`).join(' ');

	const ctlLine = line((p) => p.ctl);
	const atlLine = line((p) => p.atl);
	const tsbLine = line((p) => p.tsb);
	const zeroY = y(0);
	// Form area: the line, then back along the zero baseline and closed. One
	// polygon shades above and below zero alike — fresh and buried both read.
	const tsbArea = `M${x(0).toFixed(1)},${zeroY.toFixed(1)} L${tsbLine} L${x(n - 1).toFixed(1)},${zeroY.toFixed(1)} Z`;

	// y gridlines at a nice step, across the whole [lo, hi] extent.
	const step = niceStep((hi - lo) / 4);
	const yTicks: { y: number; value: number }[] = [];
	const firstTick = Math.ceil(lo / step) * step;
	for (let v = firstTick; v <= hi + 1e-9; v += step) {
		yTicks.push({ y: y(v), value: Math.round(v) });
	}

	// x ticks at month boundaries — the first point of each new month. Thinned so
	// a multi-year window doesn't stack labels on top of each other: keep every
	// k-th boundary (~12 labels max), but never drop a January, so the year
	// markers survive the thinning.
	const boundaries: number[] = [];
	let lastMonth = '';
	points.forEach((p, i) => {
		const month = p.date.slice(0, 7);
		if (month !== lastMonth) {
			lastMonth = month;
			boundaries.push(i);
		}
	});
	const k = Math.max(1, Math.ceil(boundaries.length / 12));
	const xTicks: { x: number; label: string }[] = [];
	boundaries.forEach((i, idx) => {
		const [yr, mo] = points[i].date.split('-').map(Number);
		if (mo !== 1 && idx % k !== 0) return; // thin non-January ticks
		xTicks.push({ x: x(i), label: mo === 1 ? String(yr) : MONTH_ABBR[mo - 1] });
	});

	return {
		ctlLine,
		atlLine,
		tsbArea,
		tsbLine,
		zeroY,
		lo,
		hi,
		yTicks,
		xTicks,
		last: points[points.length - 1],
	};
}
