// The data behind the activity detail page's one interactive profile graph —
// elevation, heart rate, power and speed on a shared x-axis (time or distance),
// each series independently toggled, and a cursor that scrubs the map.
//
// WHY THIS SENDS DOWNSAMPLED STREAM ARRAYS TO THE CLIENT WHEN THE OTHER CHARTS
// DELIBERATELY DON'T. The server-rendered SVG charts (removed in favour of this)
// never had to ship the streams because a static path is arithmetic done once.
// Scrubbing is not static: the client has to answer "what were the numbers, and
// where on the map, at the point under the cursor" for a point it doesn't know
// until the reader moves. That needs the values and the coordinates on the
// client. So we ship them — but downsampled to GRAPH_N and rounded to display
// precision, which is a few KB, not the raw multi-thousand-sample arrays.
//
// EVERYTHING IS SAMPLED AT THE SAME INDICES. The one invariant the scrub relies
// on: series[k].values[i], t[i], d[i], lat[i], lng[i] are all the same recorded
// sample. So we pick one set of indices from the longest stream and read every
// array at exactly those — never per-series filtering, which would desync the
// value readout from the map marker.
import { ALPINE } from './activity-tokens';

const M_TO_FT = 3.28084;
const MS_TO_MPH = 2.236936;

/** How many samples the client graph gets. Enough that a curve reads smooth at
 *  full page width; small enough that four of them plus lat/lng is a few KB. */
export const GRAPH_N = 500;

export interface GraphSeries {
	key: 'elevation' | 'heartrate' | 'power' | 'speed';
	label: string;
	color: string;
	unit: string;
	/** Decimal places for the cursor readout. */
	decimals: number;
	/** Display-unit values (ft, bpm, W, mph), one per shared index; null where
	 *  the sample was missing so the line breaks rather than dropping to zero. */
	values: (number | null)[];
}

export interface GraphData {
	n: number;
	/** Seconds from the start, per index — null (the whole array) if the activity
	 *  has no time stream, in which case only the distance axis is offered. */
	t: (number | null)[] | null;
	/** Metres from the start, per index — null if no distance stream. */
	d: (number | null)[] | null;
	/** Coordinates per index, for the map scrub marker. Null (the whole array)
	 *  when the streams carry no lat/lng — the graph still works, it just can't
	 *  drive a marker. Parallel arrays rather than pairs to stay compact. */
	lat: (number | null)[] | null;
	lng: (number | null)[] | null;
	series: GraphSeries[];
}

/** The evenly-spaced sample indices to read every array at. Endpoints always
 *  included so the profile starts and ends where the activity did. */
function pickIndices(len: number, n: number): number[] {
	if (len <= n) return Array.from({ length: len }, (_, i) => i);
	const step = (len - 1) / (n - 1);
	return Array.from({ length: n }, (_, i) => Math.round(i * step));
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read `arr` at `idx`, transforming and rounding present values, null otherwise. */
function sample(arr: (number | null)[] | null | undefined, idx: number[], f: (v: number) => number): (number | null)[] | null {
	if (!arr) return null;
	return idx.map((i) => (finite(arr[i]) ? f(arr[i] as number) : null));
}

/** The streams this needs, structurally — `ActivityStreams` satisfies it. */
export interface GraphStreams {
	time_s?: number[] | null;
	distance_m?: number[] | null;
	altitude_m?: number[] | null;
	heartrate?: number[] | null;
	power_w?: number[] | null;
	speed_ms?: number[] | null;
	latlng?: [number, number][] | null;
}

/** Build the client graph payload, or null when there is nothing plottable — no
 *  series with two real points, or neither a time nor a distance axis to lay
 *  them on. */
export function buildGraphData(streams: GraphStreams | null | undefined, n = GRAPH_N): GraphData | null {
	if (!streams) return null;

	const lens = [streams.time_s, streams.distance_m, streams.altitude_m, streams.heartrate, streams.power_w, streams.speed_ms].map(
		(a) => a?.length ?? 0,
	);
	const len = Math.max(...lens);
	if (len < 2) return null;
	const idx = pickIndices(len, n);

	// Axes are offsets from the first sample so both read from zero.
	const offsetFromStart = (raw: (number | null)[] | null): (number | null)[] | null => {
		if (!raw || !finite(raw[0])) return null;
		const base = raw[0] as number;
		return raw.map((v) => (v == null ? null : Math.round(v - base)));
	};
	const t = offsetFromStart(sample(streams.time_s, idx, (v) => v));
	const d = offsetFromStart(sample(streams.distance_m, idx, (v) => v));
	// A profile needs at least one axis to lay points on.
	if (!t && !d) return null;

	const latlng = streams.latlng ?? null;
	const lat = latlng ? idx.map((i) => (latlng[i] ? Number(latlng[i][0].toFixed(5)) : null)) : null;
	const lng = latlng ? idx.map((i) => (latlng[i] ? Number(latlng[i][1].toFixed(5)) : null)) : null;

	const candidates: GraphSeries[] = [
		{ key: 'elevation', label: 'Elevation', color: ALPINE.fir, unit: 'ft', decimals: 0, values: sample(streams.altitude_m, idx, (v) => Math.round(v * M_TO_FT)) ?? [] },
		{ key: 'heartrate', label: 'Heart rate', color: ALPINE.alpenglow, unit: 'bpm', decimals: 0, values: sample(streams.heartrate, idx, (v) => Math.round(v)) ?? [] },
		{ key: 'power', label: 'Power', color: ALPINE.larch, unit: 'W', decimals: 0, values: sample(streams.power_w, idx, (v) => Math.round(v)) ?? [] },
		{ key: 'speed', label: 'Speed', color: ALPINE.lake, unit: 'mph', decimals: 1, values: sample(streams.speed_ms, idx, (v) => Number((v * MS_TO_MPH).toFixed(1))) ?? [] },
	];
	// Keep a series only if it has two real points to draw a line between.
	const series = candidates.filter((s) => s.values.filter(finite).length >= 2);
	if (series.length === 0) return null;

	return { n: idx.length, t, d, lat, lng, series };
}
