// View models for the MTA Savant pages, so the .astro files only lay things out.
import {
	inYear,
	loadDataset,
	monthLabel,
	monthlyMedian,
	pctColor,
	pctInk,
	percentiles,
	trailing,
	type Dataset,
	type Line,
	type Mode,
} from './mta-savant';

export const MODES: Mode[] = ['subway', 'bus'];

const TREND_W = 300;

const TREND_H = 110;

const PAD = 6;

export interface Trend {
	label: string;
	line: string;
	median: string;
	top: string;
	bottom: string;
	from: string;
	to: string;
}

function trend(ds: Dataset, id: string, key: string): Trend | null {
	const metric = ds.metrics.find((m) => m.key === key)!;

	const own = [...(ds.data.get(id) ?? [])]
		.flatMap(([month, row]) => (row[key]?.den ? [[month, row[key].num / row[key].den] as const] : []))
		.sort(([a], [b]) => a.localeCompare(b));

	if (own.length < 2) return null;
	const from = own[0][0];
	const medians = [...monthlyMedian(ds, key)].filter(([m]) => m >= from).sort(([a], [b]) => a.localeCompare(b));
	const all = [...own.map(([, v]) => v), ...medians.map(([, v]) => v)];
	const lo = Math.min(...all);
	const hi = Math.max(...all);

	// Months since `from`, so a gap in reporting is a gap in x, not a squeeze.
	const idx = (m: string) => {
		const [y0, m0] = from.split('-').map(Number);
		const [y, mm] = m.split('-').map(Number);

		return (y - y0) * 12 + (mm - m0);
	};

	const span = Math.max(1, idx(ds.latest));
	const x = (m: string) => PAD + ((TREND_W - 2 * PAD) * idx(m)) / span;
	const y = (v: number) => TREND_H - PAD - ((TREND_H - 2 * PAD) * (v - lo)) / (hi - lo || 1);

	const path = (pts: (readonly [string, number])[]) =>
		pts.map(([m, v], i) => `${i ? 'L' : 'M'}${x(m).toFixed(1)} ${y(v).toFixed(1)}`).join('');

	return {
		label: metric.label,
		line: path(own),
		median: path(medians),
		top: metric.format(hi),
		bottom: metric.format(lo),
		from: monthLabel(from),
		to: monthLabel(ds.latest),
	};
}

const prefix = (id: string) => id.match(/^[A-Z]+/)?.[0];

export const TREND_VIEWBOX = `0 0 ${TREND_W} ${TREND_H}`;

export async function linePage(mode: Mode, slug: string) {
	const ds = await loadDataset(mode);
	const line = ds.lines.find((l) => l.slug === slug)!;
	const window = trailing(ds);

	const rankings = ds.metrics.map((m) => {
		const p = percentiles(ds, m.key, 'trailing', window).get(line.id);

		return {
			label: m.label,
			value: p ? m.format(p.value) : '—',
			pct: p?.pct ?? null,
			rank: p ? `${p.rank} of ${p.of}` : '',
			color: p ? pctColor(p.pct) : '',
			ink: p ? pctInk(p.pct) : '',
		};
	});

	const years = new Set<number>();

	for (const month of ds.data.get(line.id)?.keys() ?? []) years.add(Number(month.slice(0, 4)));

	const row = (label: string, pick: (m: string) => boolean, window: string) => ({
		label,
		cells: ds.metrics.map((m) => {
			const p = percentiles(ds, m.key, window, pick).get(line.id);

			return p ? { text: m.format(p.value), color: pctColor(p.pct), ink: pctInk(p.pct) } : { text: '—', color: '', ink: '' };
		}),
	});

	const table = [
		...[...years].sort((a, b) => a - b).map((yr) => row(String(yr), inYear(yr), String(yr))),
		row('Last 12 mo', window, 'trailing'),
	];

	return {
		line,
		latest: monthLabel(ds.latest),
		metricLabels: ds.metrics.map((m) => m.label),
		rankings,
		table,
		trends: ds.metrics.map((m) => trend(ds, line.id, m.key)).filter((t): t is Trend => t !== null),
		// 350-odd bus routes is too many to list; keep to the same prefix (B, BX, Q, SIM...).
		siblings: mode === 'subway' ? ds.lines : ds.lines.filter((l) => prefix(l.id) === prefix(line.id)),
	};
}

export async function leaderboard(mode: Mode) {
	const ds = await loadDataset(mode);
	const window = trailing(ds);
	const ranks = ds.metrics.map((m) => percentiles(ds, m.key, 'trailing', window));

	const rows = ds.lines
		.map((line: Line) => ({
			line,
			cells: ds.metrics.map((m, i) => {
				const p = ranks[i].get(line.id);

				return p ? { text: m.format(p.value), color: pctColor(p.pct), ink: pctInk(p.pct), pct: p.pct } : null;
			}),
		}))
		// Retired routes with nothing in the window stay reachable from their own page, not here.
		.filter((r) => r.cells.some(Boolean));

	return { latest: monthLabel(ds.latest), metricLabels: ds.metrics.map((m) => m.label), rows };
}
