// The view models for a ski day's detail page — the read-only "Runs & lifts"
// breakdown and the editor rows behind it. All arithmetic (imperial conversion,
// per-run sparklines) lives here so the components are only markup, matching
// formatStat in sports.ts: display units are decided in lib, not in frontmatter.
//
// Both builders take an already-resolved `SkiSegment[]` (from
// `resolveSkiSegments`, which honours a saved edit) rather than recomputing, so
// a correction shows up identically wherever these are rendered.

import type { SkiSegment, SkiStreams } from './ski';
import { summarizeSki } from './ski';

const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;
const MS_TO_MPH = 2.236936;
const SPARK_POINTS = 24;

function feet(m: number): number {
	return m / METERS_PER_FOOT;
}

/** "1h 12m" / "12m" / "45s" — same shape as the page's own formatDuration. */
function dur(seconds: number): string {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s % 60}s`;
}

export interface SkiRunView {
	kind: 'run';
	/** 1-based run number, in day order. */
	index: number;
	verticalFt: number;
	duration: string;
	avgMph: number | null;
	distanceMi: number | null;
	/** Altitude down the run, normalised 0 (day's low) … 1 (day's high) and
	 *  downsampled — the y-values for a small descending sparkline. */
	spark: number[];
}

export interface SkiLiftView {
	kind: 'lift';
	duration: string;
	gainFt: number;
}

export interface SkiView {
	summary: {
		runs: number;
		lifts: number;
		verticalFt: number;
		timeSkiing: string;
		liftTime: string;
		longestRunFt: number;
		maxSpeedMph: number | null;
	};
	items: (SkiRunView | SkiLiftView)[];
}

/** One editable row — every segment including idle, so the partition the owner
 *  edits is complete. `t0`/`t1` (seconds from start) address the segment when
 *  the edit is saved back as a `SkiSegmentOverride`. */
export interface SkiEditRow {
	t0: number;
	t1: number;
	type: SkiSegment['type'];
	/** Run number when this row is currently a run, else null — a label that
	 *  renumbers live as the reader reclassifies. */
	runIndex: number | null;
	verticalFt: number;
	duration: string;
	avgMph: number | null;
	distanceMi: number | null;
}

/** Build the read-only breakdown, or null when there are no runs (a mislabelled
 *  flat activity, or one edited down to nothing). `maxSpeedMs` is the activity's
 *  stored top speed — the per-sample speed stream is too GPS-noisy for a max, so
 *  the day max comes from the column and per-run speed is an average. */
export function buildSkiView(segments: SkiSegment[], streams: SkiStreams, maxSpeedMs: number | null): SkiView | null {
	const summary = summarizeSki(segments);
	if (summary.runCount === 0) return null;

	const alt = streams.altitude_m ?? [];
	// Sparklines share ONE altitude scale — the day's low to high — so a short
	// blue run and a top-to-bottom black read at their true relative drop.
	let lo = Infinity;
	let hi = -Infinity;
	for (const seg of segments) {
		if (seg.type !== 'run') continue;
		for (let i = seg.startIdx; i <= seg.endIdx; i++) {
			const a = alt[i];
			if (a < lo) lo = a;
			if (a > hi) hi = a;
		}
	}
	const span = hi - lo || 1;

	let runIndex = 0;
	const items: (SkiRunView | SkiLiftView)[] = [];
	for (const seg of segments) {
		if (seg.type === 'run') {
			runIndex++;
			items.push({
				kind: 'run',
				index: runIndex,
				verticalFt: Math.round(feet(seg.vertical)),
				duration: dur(seg.seconds),
				avgMph: seg.avgSpeedMs != null ? seg.avgSpeedMs * MS_TO_MPH : null,
				distanceMi: seg.distanceM != null ? seg.distanceM / METERS_PER_MILE : null,
				spark: sparkline(alt, seg.startIdx, seg.endIdx, lo, span),
			});
		} else if (seg.type === 'lift') {
			items.push({ kind: 'lift', duration: dur(seg.seconds), gainFt: Math.round(feet(seg.vertical)) });
		}
		// 'idle' segments are left out of the read view — neither a run to log nor
		// a lift to wait on. They ARE in the edit rows, so they can be reclassified.
	}

	return {
		summary: {
			runs: summary.runCount,
			lifts: summary.liftCount,
			verticalFt: Math.round(feet(summary.verticalM)),
			timeSkiing: dur(summary.runSeconds),
			liftTime: dur(summary.liftSeconds),
			longestRunFt: Math.round(feet(summary.longestRunVerticalM)),
			maxSpeedMph: maxSpeedMs != null ? maxSpeedMs * MS_TO_MPH : null,
		},
		items,
	};
}

/** Every segment as an editable row (idle included), in day order. */
export function buildSkiEditRows(segments: SkiSegment[]): SkiEditRow[] {
	let runIndex = 0;
	return segments.map((seg) => {
		const runNo = seg.type === 'run' ? ++runIndex : null;
		return {
			t0: Math.round(seg.startTime),
			t1: Math.round(seg.endTime),
			type: seg.type,
			runIndex: runNo,
			verticalFt: Math.round(feet(seg.vertical)),
			duration: dur(seg.seconds),
			avgMph: seg.avgSpeedMs != null ? seg.avgSpeedMs * MS_TO_MPH : null,
			distanceMi: seg.distanceM != null ? seg.distanceM / METERS_PER_MILE : null,
		};
	});
}

/** Downsample altitude[a..b] to SPARK_POINTS values, each normalised into the
 *  shared [lo, lo+span] scale so 1 is the day's high and 0 its low. */
function sparkline(alt: number[], a: number, b: number, lo: number, span: number): number[] {
	const count = b - a;
	if (count <= 0) return [];
	const n = Math.min(SPARK_POINTS, count + 1);
	const out: number[] = [];
	for (let k = 0; k < n; k++) {
		const idx = a + Math.round((k / (n - 1)) * count);
		out.push((alt[idx] - lo) / span);
	}
	return out;
}
