// MTA Savant: Baseball Savant-style pages for subway lines and bus routes, built
// from the MTA's monthly performance datasets on data.ny.gov (Socrata, no key).
// Fetched at build time only — every page is prerendered, and the data is
// monthly, so a deploy is fresh enough.
//
// Every metric is a ratio of two sums grouped by line and month (wait assessment
// = passing timepoints / scheduled timepoints, and so on), so a year, the trailing
// 12 months or a single month all aggregate the same way: sum the parts, divide.
// A metric with no denominator is a count, averaged per month.

const SOCRATA = 'https://data.ny.gov/resource';

export type Mode = 'subway' | 'bus';

interface Series {
	ds: string;
	expr: string;
}

export interface Metric {
	key: string;
	label: string;
	higherIsBetter: boolean;
	format: (v: number) => string;
	num: Series;
	den?: Series;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const min = (v: number) => `${(Math.round(v * 100) / 100 || 0).toFixed(2)}m`;

const int = (v: number) => Math.round(v).toLocaleString('en-US');

const SUBWAY_CJ = 'r7qk-6tcy';

const SUBWAY_OTP = 'f6rf-2a3t';

const BUS_CJ = '8mkn-d32t';

export const METRICS: Record<Mode, Metric[]> = {
	subway: [
		{
			key: 'riders',
			label: 'Riders / mo',
			higherIsBetter: true,
			format: int,
			num: { ds: SUBWAY_CJ, expr: 'sum(num_passengers)' },
		},
		{
			key: 'wait',
			label: 'Wait assessment',
			higherIsBetter: true,
			format: pct,
			num: { ds: 's666-h6b7', expr: 'sum(num_timepoints_passing_wait_assessment)' },
			den: { ds: 's666-h6b7', expr: 'sum(num_sched_timepoints)' },
		},
		{
			key: 'otp',
			label: 'Terminal on-time',
			higherIsBetter: true,
			format: pct,
			num: { ds: SUBWAY_OTP, expr: 'sum(num_on_time_trips)' },
			den: { ds: SUBWAY_OTP, expr: 'sum(num_sched_trips)' },
		},
		{
			key: 'delivered',
			label: 'Service delivered',
			higherIsBetter: true,
			format: pct,
			num: { ds: '32ch-sei3', expr: 'sum(num_actual_trains)' },
			den: { ds: '32ch-sei3', expr: 'sum(num_sched_trains)' },
		},
		{
			key: 'cjtp',
			label: 'Journey on time',
			higherIsBetter: true,
			format: pct,
			num: { ds: SUBWAY_CJ, expr: 'sum(num_passengers)-sum(over_five_mins)' },
			den: { ds: SUBWAY_CJ, expr: 'sum(num_passengers)' },
		},
		{
			key: 'apt',
			label: 'Extra platform time',
			higherIsBetter: false,
			format: min,
			num: { ds: SUBWAY_CJ, expr: 'sum(total_apt)' },
			den: { ds: SUBWAY_CJ, expr: 'sum(num_passengers)' },
		},
		{
			key: 'att',
			label: 'Extra train time',
			higherIsBetter: false,
			format: min,
			num: { ds: SUBWAY_CJ, expr: 'sum(total_att)' },
			den: { ds: SUBWAY_CJ, expr: 'sum(num_passengers)' },
		},
		{
			// Per 1,000 scheduled trips, so a long, busy line isn't punished for its size.
			key: 'delays',
			label: 'Delays / 1k trips',
			higherIsBetter: false,
			format: (v) => (v * 1000).toFixed(0),
			num: { ds: '9zbp-wz3y', expr: 'sum(delays)' },
			den: { ds: SUBWAY_OTP, expr: 'sum(num_sched_trips)' },
		},
		{
			key: 'incidents',
			label: 'Major incidents / mo',
			higherIsBetter: false,
			format: (v) => v.toFixed(1),
			num: { ds: 'ereg-mcvp', expr: 'sum(count)' },
		},
	],
	bus: [
		{
			key: 'riders',
			label: 'Riders / mo',
			higherIsBetter: true,
			format: int,
			num: { ds: BUS_CJ, expr: 'sum(number_of_customers)' },
		},
		{
			key: 'speed',
			label: 'Avg speed',
			higherIsBetter: true,
			format: (v) => `${v.toFixed(1)} mph`,
			num: { ds: 'cudb-vcni', expr: 'sum(total_mileage)' },
			den: { ds: 'cudb-vcni', expr: 'sum(total_operating_time)' },
		},
		{
			key: 'wait',
			label: 'Wait assessment',
			higherIsBetter: true,
			format: pct,
			num: { ds: 'v4z4-2h6n', expr: 'sum(number_of_trips_passing_wait)' },
			den: { ds: 'v4z4-2h6n', expr: 'sum(number_of_scheduled_trips)' },
		},
		{
			key: 'delivered',
			label: 'Service delivered',
			higherIsBetter: true,
			format: pct,
			num: { ds: '6qwi-vjde', expr: 'sum(actual_number_of_buses)' },
			den: { ds: '6qwi-vjde', expr: 'sum(scheduled_number_of_buses)' },
		},
		{
			key: 'cjtp',
			label: 'Journey on time',
			higherIsBetter: true,
			format: pct,
			num: { ds: BUS_CJ, expr: 'sum(customer_journey_time*number_of_customers)' },
			den: { ds: BUS_CJ, expr: 'sum(number_of_customers)' },
		},
		{
			key: 'abst',
			label: 'Extra stop time',
			higherIsBetter: false,
			format: min,
			num: { ds: BUS_CJ, expr: 'sum(additional_bus_stop_time*number_of_customers)' },
			den: { ds: BUS_CJ, expr: 'sum(number_of_customers)' },
		},
		{
			key: 'att',
			label: 'Extra travel time',
			higherIsBetter: false,
			format: min,
			num: { ds: BUS_CJ, expr: 'sum(additional_travel_time*number_of_customers)' },
			den: { ds: BUS_CJ, expr: 'sum(number_of_customers)' },
		},
	],
};

// The datasets renamed the shuttles and split/merged J/Z in September 2024;
// fold the new codes into the old so a line's history stays one line.
const SUBWAY_ALIAS = new Map([
	['FS', 'S Fkln'],
	['GS', 'S 42nd'],
	['H', 'S Rock'],
	['J', 'JZ'],
]);

interface LineStyle {
	name: string;
	color: string;
	text?: string;
}

const SUBWAY_INFO = new Map<string, LineStyle>(
	Object.entries({
	'1': { name: '1', color: '#EE352E' },
	'2': { name: '2', color: '#EE352E' },
	'3': { name: '3', color: '#EE352E' },
	'4': { name: '4', color: '#00933C' },
	'5': { name: '5', color: '#00933C' },
	'6': { name: '6', color: '#00933C' },
	'7': { name: '7', color: '#B933AD' },
	A: { name: 'A', color: '#0039A6' },
	C: { name: 'C', color: '#0039A6' },
	E: { name: 'E', color: '#0039A6' },
	B: { name: 'B', color: '#FF6319' },
	D: { name: 'D', color: '#FF6319' },
	F: { name: 'F', color: '#FF6319' },
	M: { name: 'M', color: '#FF6319' },
	G: { name: 'G', color: '#6CBE45' },
	JZ: { name: 'J/Z', color: '#996633' },
	L: { name: 'L', color: '#A7A9AC' },
	N: { name: 'N', color: '#FCCC0A', text: '#000' },
	Q: { name: 'Q', color: '#FCCC0A', text: '#000' },
	R: { name: 'R', color: '#FCCC0A', text: '#000' },
	W: { name: 'W', color: '#FCCC0A', text: '#000' },
	'S 42nd': { name: '42 St Shuttle', color: '#808183' },
	'S Fkln': { name: 'Franklin Av Shuttle', color: '#808183' },
	'S Rock': { name: 'Rockaway Park Shuttle', color: '#808183' },
	})
);

export interface Line {
	id: string;
	slug: string;
	/** What goes in the bullet. */
	short: string;
	name: string;
	color: string;
	text: string;
	group: string;
}

/** Sums for one line in one month, keyed by metric. */
type Month = Record<string, { num: number; den: number }>;

export interface Dataset {
	mode: Mode;
	metrics: Metric[];
	lines: Line[];
	/** line id → 'YYYY-MM' → sums */
	data: Map<string, Map<string, Month>>;
	/** Last month any metric reports, 'YYYY-MM'. */
	latest: string;
}

export const slugOf = (id: string) => id.toLowerCase().replace('+', '-sbs').replace(/\s+/g, '-');

async function soql<T>(ds: string, params: Record<string, string>): Promise<T[]> {
	const url = `${SOCRATA}/${ds}.json?${new URLSearchParams({ $limit: '100000', ...params })}`;
	const res = await fetch(url);

	if (!res.ok) throw new Error(`data.ny.gov ${ds}: ${res.status} ${await res.text()}`);

	return res.json();
}

// ponytail: 2019 floor keeps the bus pulls to ~35k rows each; widen if older seasons matter.
const SINCE = "month >= '2019-01-01'";

async function series(mode: Mode, s: Series) {
	const col = mode === 'subway' ? 'line' : 'route_id';

	const rows = await soql<Record<string, string>>(s.ds, {
		$select: `${col} as id, month, ${s.expr} as v`,
		$where: `${SINCE} and ${col} is not null`,
		$group: `${col}, month`,
	});

	return rows.map((r) => ({
		id: mode === 'subway' ? (SUBWAY_ALIAS.get(r.id) ?? r.id) : r.id,
		month: r.month.slice(0, 7),
		v: Number(r.v),
	}));
}

async function busRoutes() {
	const rows = await soql<Record<string, string>>('bzwk-3hb4', {
		$select: 'route_id, route_long_name, route_color, route_type',
		$where: "in_effect = 'true'",
		$group: 'route_id, route_long_name, route_color, route_type',
	});

	// A route can carry several types (an SBS also runs school trips); school rows go
	// first so the everyday type is the one left in the map.
	const school = (r: Record<string, string>) => (/school/i.test(r.route_type) ? 0 : 1);

	return new Map(rows.sort((a, b) => school(a) - school(b)).map((r) => [r.route_id, r]));
}

async function load(mode: Mode): Promise<Dataset> {
	const metrics = METRICS[mode];
	// One request per distinct series; several metrics share a denominator.
	const wanted = new Map<string, Series>();

	for (const m of metrics) for (const s of [m.num, m.den]) if (s) wanted.set(`${s.ds}|${s.expr}`, s);

	const fetched = new Map(
		await Promise.all([...wanted].map(async ([k, s]) => [k, await series(mode, s)] as const))
	);

	const data: Dataset['data'] = new Map();

	const cell = (id: string, month: string, key: string) => {
		let byMonth = data.get(id);

		if (!byMonth) data.set(id, (byMonth = new Map()));
		let row = byMonth.get(month);

		if (!row) byMonth.set(month, (row = {}));

		return (row[key] ??= { num: 0, den: 0 });
	};

	for (const m of metrics) {
		for (const r of fetched.get(`${m.num.ds}|${m.num.expr}`)!) cell(r.id, r.month, m.key).num += r.v;
		// A count's denominator is months, one per row.
		const den = m.den ? fetched.get(`${m.den.ds}|${m.den.expr}`)! : fetched.get(`${m.num.ds}|${m.num.expr}`)!;

		// Only months the numerator reports: delays start in 2020, the trips they divide by in 2015.
		for (const r of den) if (data.get(r.id)?.get(r.month)?.[m.key]) cell(r.id, r.month, m.key).den += m.den ? r.v : 1;
	}

	const routes = mode === 'bus' ? await busRoutes() : null;

	const lines: Line[] = [...data.keys()]
		.flatMap((id): Line[] => {
			if (mode === 'subway') {
				const info = SUBWAY_INFO.get(id);

				if (!info) return [];

				return [{
					id,
					slug: slugOf(id),
					short: id.startsWith('S ') ? 'S' : info.name,
					name: info.name.length > 3 ? info.name : `${info.name} train`,
					color: info.color,
					text: info.text ?? '#fff',
					group: 'Subway',
				}];
			}

			const r = routes!.get(id);

			return [{
				id,
				slug: slugOf(id),
				short: id,
				name: r?.route_long_name ?? id,
				color: r?.route_color ? `#${r.route_color}` : '#555',
				text: '#fff',
				group: r?.route_type ?? 'Bus',
			}];
		})
		.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

	let latest = '';

	for (const byMonth of data.values()) for (const k of byMonth.keys()) if (k > latest) latest = k;

	return { mode, metrics, lines, data, latest };
}

const cache = new Map<Mode, Promise<Dataset>>();

export const loadDataset = (mode: Mode) => {
	if (!cache.has(mode)) cache.set(mode, load(mode));

	return cache.get(mode)!;
};

/** Value of one metric for one line over the months `pick` accepts; null when unreported. */
export function valueOf(ds: Dataset, id: string, key: string, pick: (month: string) => boolean): number | null {
	let num = 0;
	let den = 0;

	for (const [month, row] of ds.data.get(id) ?? []) {
		const c = row[key];

		if (!c || !pick(month)) continue;
		num += c.num;
		den += c.den;
	}

	return den > 0 ? num / den : null;
}

/** The trailing 12 months ending at the dataset's latest month: the "season" percentiles rank. */
export function trailing(ds: Dataset) {
	const [y, m] = ds.latest.split('-').map(Number);
	const from = m === 12 ? `${y}-01` : `${y - 1}-${String(m + 1).padStart(2, '0')}`;

	return (month: string) => month >= from && month <= ds.latest;
}

export const inYear = (year: number) => (month: string) => month.startsWith(`${year}-`);

// ponytail: O(n²) per metric, memoized so 350 bus pages pay it once per window.
const memo = new Map<string, Map<string, { value: number; pct: number; rank: number; of: number }>>();

/**
 * Percentile rank, 0–100, where 100 is best: the share of other lines this one beats.
 * Lines with no value for the window are left out of the field.
 */
export function percentiles(ds: Dataset, key: string, window: string, pick: (month: string) => boolean) {
	const memoKey = `${ds.mode}|${key}|${window}`;
	const hit = memo.get(memoKey);

	if (hit) return hit;
	const metric = ds.metrics.find((m) => m.key === key)!;

	const vals = ds.lines
		.map((l) => ({ id: l.id, v: valueOf(ds, l.id, key, pick) }))
		.filter((x): x is { id: string; v: number } => x.v !== null);

	const out = new Map<string, { value: number; pct: number; rank: number; of: number }>();

	for (const x of vals) {
		const beaten = vals.filter((o) => (metric.higherIsBetter ? o.v < x.v : o.v > x.v)).length;
		const better = vals.filter((o) => (metric.higherIsBetter ? o.v > x.v : o.v < x.v)).length;
		out.set(x.id, {
			value: x.v,
			pct: vals.length > 1 ? Math.round((100 * beaten) / (vals.length - 1)) : 50,
			rank: better + 1,
			of: vals.length,
		});
	}

	memo.set(memoKey, out);

	return out;
}

/** Savant's scale: deep blue (worst) through gray to deep red (best). */
export function pctColor(p: number) {
	const blue = [53, 97, 173];
	const gray = [200, 200, 200];
	const red = [215, 33, 41];
	const [a, b, t] = p < 50 ? [blue, gray, p / 50] : [gray, red, (p - 50) / 50];

	return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`;
}

export function monthLabel(ym: string) {
	const [y, m] = ym.split('-').map(Number);

	return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const medianMemo = new Map<string, Map<string, number>>();

/** The field's median for one metric, month by month: the reference line on a trend chart. */
export function monthlyMedian(ds: Dataset, key: string) {
	const memoKey = `${ds.mode}|${key}`;
	const hit = medianMemo.get(memoKey);

	if (hit) return hit;
	const byMonth = new Map<string, number[]>();

	for (const byLine of ds.data.values()) {
		for (const [month, row] of byLine) {
			const c = row[key];

			if (c && c.den > 0) (byMonth.get(month) ?? byMonth.set(month, []).get(month)!).push(c.num / c.den);
		}
	}

	const out = new Map<string, number>();

	for (const [month, vs] of byMonth) {
		vs.sort((a, b) => a - b);
		out.set(month, vs[Math.floor(vs.length / 2)]);
	}

	medianMemo.set(memoKey, out);

	return out;
}

/** Text color that reads on pctColor(p). */
export const pctInk = (p: number) => (p > 22 && p < 78 ? '#1a1a1a' : '#fff');
