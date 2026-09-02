// Lift/run segmentation for a lift-served ski or snowboard day — the thing a
// resort day is actually made of, which neither the file nor Strava records as
// such. A Slopes/Strava ski export is one long track: the app knows it was 20
// runs and 20 lift rides, but all that reaches us is a sawtooth in the altitude
// stream. This file recovers the runs and the lifts from that sawtooth, so two
// things downstream can be honest:
//
//   1. EXERTION. §3's MET floor multiplies a duration by a sport MET. For a
//      resort day the only duration in the file is either `elapsed` (six hours,
//      most of it a chairlift or the lodge) or, worse, the Slopes-exported
//      `moving_seconds`, which for this archive is broken — 465s for a full day
//      with 10,000m of vertical. Neither is "how long was spent skiing". The
//      run segments are: their summed duration is the active-descent time, and
//      that is what exertion.ts scores instead. Lift time and standing time are
//      excluded because sitting on a chairlift is not training stress (§3's
//      "moving time, never elapsed" taken to its real conclusion for this sport).
//
//   2. DISPLAY. The detail page can show the day the way Slopes does — a list of
//      runs with each run's vertical, speed and duration — instead of a single
//      lift-contaminated blob. The `activity_laps` rows for these days are
//      Strava's arbitrary auto-laps (each spans part of a lift AND part of a
//      run), so they are useless as runs; these segments are the real thing.
//
// WHY ALTITUDE AND NOT SPEED. The speed stream on these GPS exports is full of
// spikes — 55 m/s (200 km/h) samples that are plainly GPS error, next to real
// 20 m/s descents. Altitude drifts and wiggles but its TREND is clean: a lift
// climbs for minutes, a run drops for minutes, and a hysteresis band over the
// smoothed altitude separates the two without ever trusting an instantaneous
// speed. Speed is used only to annotate a detected run's top speed, and only
// after discarding the physically-impossible samples.
//
// PURE FUNCTIONS OVER STREAMS, exactly like exertion.ts — no I/O, no database —
// so exertion can call it during a bulk recompute and the detail page can call
// it live off the streams it already fetched, with no stored segment table to
// keep in sync.

export interface SkiStreams {
	time_s?: number[];
	altitude_m?: number[];
	distance_m?: number[];
	speed_ms?: number[];
	latlng?: [number, number][];
	moving?: boolean[];
}

export type SkiSegmentType = 'run' | 'lift' | 'idle';

export interface SkiSegment {
	type: SkiSegmentType;
	startIdx: number;
	endIdx: number;
	/** Seconds-from-start of the first and last sample, and their difference. */
	startTime: number;
	endTime: number;
	seconds: number;
	startAlt: number;
	endAlt: number;
	/** Metres descended (runs) or climbed (lifts), always positive. 0 for idle. */
	vertical: number;
	distanceM: number | null;
	/** Average ground speed over the segment (distance ÷ time), m/s. Averaged
	 *  over the whole run, so the GPS jitter that makes a per-sample MAX speed
	 *  unrecoverable from these exports washes out. Null without a distance. */
	avgSpeedMs: number | null;
}

export interface SkiSummary {
	runCount: number;
	liftCount: number;
	runSeconds: number;
	liftSeconds: number;
	/** Everything that is neither a run nor a lift: standing at the top, the
	 *  lift queue, lunch, the walk to the car. */
	otherSeconds: number;
	/** Summed run descent — the day's real vertical, independent of
	 *  elevation_loss_m (which also counts a run's small counter-slopes). */
	verticalM: number;
	longestRunVerticalM: number;
}

// Tuned against this archive's Slopes/Strava exports (see ski.test.mjs). All in
// metres/seconds. NOISE is the altitude wiggle ignored before a reversal counts
// as a real turn (GPS/baro noise on these files runs a few metres); MIN_*_M are
// how much net vertical a segment needs before it's a real run or lift rather
// than a traverse or a mid-station bump.
const NOISE_M = 8;
const MIN_RUN_M = 25;
const MIN_LIFT_M = 25;
const SMOOTH_WINDOW_S = 15;

/** Centered moving average of `values` over a ±window/2 second window, so a
 *  handful of noisy metres don't register as a turn. Two-pointer, O(n). */
function smoothOverTime(values: number[], time: number[], windowS: number): number[] {
	const n = values.length;
	const out = new Array<number>(n);
	const half = windowS / 2;
	let lo = 0;
	let hi = 0;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		while (lo < n && time[lo] < time[i] - half) {
			sum -= values[lo];
			lo++;
		}
		while (hi < n && time[hi] <= time[i] + half) {
			sum += values[hi];
			hi++;
		}
		out[i] = sum / (hi - lo);
	}
	return out;
}

/** A saved, hand-corrected partition (one entry per segment, in order), stored
 *  on the activity as `ski_segments`. Times are seconds-from-start so the edit
 *  survives a re-import at a different sample resolution; `resolveSkiSegments`
 *  maps them back to the nearest samples. When this is present it REPLACES
 *  detection for that activity — both on screen and in the exertion score. */
export interface SkiSegmentOverride {
	t0: number;
	t1: number;
	type: SkiSegmentType;
}

/** A segment as index bounds + a type, before it's enriched with distance and
 *  speed — the shared shape detection and a saved override both reduce to. */
interface RawSegment {
	startIdx: number;
	endIdx: number;
	type: SkiSegmentType;
}

/**
 * Auto-detect the raw run/lift/idle partition from the altitude sawtooth. Splits
 * the track at its turning points: a turning point is confirmed only once the
 * smoothed altitude has reversed by NOISE_M from a running extreme, so small
 * wiggles inside a long lift or run don't shatter it into fragments.
 */
function autoRawSegments(streams: SkiStreams): RawSegment[] {
	const t = streams.time_s;
	const alt = streams.altitude_m;
	if (!t || !alt || t.length < 10 || alt.length !== t.length) return [];

	const salt = smoothOverTime(alt, t, SMOOTH_WINDOW_S);
	const n = salt.length;

	// Turning-point walk. `dir` is the confirmed direction of the segment in
	// progress; a segment closes at the running extreme (a peak when we were
	// climbing, a trough when descending) the moment the altitude pulls NOISE_M
	// back off it.
	const pivots: number[] = [0];
	let dir: 0 | 1 | -1 = 0;
	let maxIdx = 0;
	let minIdx = 0;
	for (let i = 1; i < n; i++) {
		if (salt[i] > salt[maxIdx]) maxIdx = i;
		if (salt[i] < salt[minIdx]) minIdx = i;

		if (dir !== -1 && salt[maxIdx] - salt[i] >= NOISE_M) {
			// A drop off the running peak → the up/flat segment ended at that peak.
			pivots.push(maxIdx);
			dir = -1;
			minIdx = i;
		} else if (dir !== 1 && salt[i] - salt[minIdx] >= NOISE_M) {
			// A rise off the running trough → the down/flat segment ended there.
			pivots.push(minIdx);
			dir = 1;
			maxIdx = i;
		}
	}
	if (pivots[pivots.length - 1] !== n - 1) pivots.push(n - 1);

	const raw: RawSegment[] = [];
	for (let p = 0; p < pivots.length - 1; p++) {
		const startIdx = pivots[p];
		const endIdx = pivots[p + 1];
		if (endIdx <= startIdx) continue;
		const delta = salt[endIdx] - salt[startIdx];
		raw.push({
			startIdx,
			endIdx,
			type: delta <= -MIN_RUN_M ? 'run' : delta >= MIN_LIFT_M ? 'lift' : 'idle',
		});
	}
	return raw;
}

/** Map a saved override's second-offsets back to sample index bounds. */
function overrideRawSegments(streams: SkiStreams, override: SkiSegmentOverride[]): RawSegment[] {
	const t = streams.time_s;
	if (!t || t.length < 2) return [];
	const nearest = (target: number): number => {
		// Binary search on the monotonic time axis.
		let lo = 0;
		let hi = t.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (t[mid] < target) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0 && Math.abs(t[lo - 1] - target) <= Math.abs(t[lo] - target)) return lo - 1;
		return lo;
	};
	const raw: RawSegment[] = [];
	for (const seg of override) {
		const startIdx = nearest(seg.t0);
		const endIdx = nearest(seg.t1);
		if (endIdx > startIdx) raw.push({ startIdx, endIdx, type: seg.type });
	}
	return raw;
}

/** Merge neighbouring segments of the same type into one. This is what turns a
 *  reclassification into a merge: relabel the idle sitting between two runs and
 *  the three collapse into a single run, on screen and in the score. */
function coalesce(raw: RawSegment[]): RawSegment[] {
	const out: RawSegment[] = [];
	for (const seg of raw) {
		const last = out[out.length - 1];
		if (last && last.type === seg.type && seg.startIdx <= last.endIdx + 1) last.endIdx = seg.endIdx;
		else out.push({ ...seg });
	}
	return out;
}

/** Turn index bounds + a type into a full `SkiSegment` (distance, speed, times).
 *  `type` is taken as given — for an override it is the human's call, not the
 *  altitude's, so a lift hiked as a run stays a run even though it climbed. */
function enrich(streams: SkiStreams, raw: RawSegment[]): SkiSegment[] {
	const t = streams.time_s!;
	const alt = streams.altitude_m!;
	return raw.map(({ startIdx, endIdx, type }) => {
		const seconds = Math.max(0, t[endIdx] - t[startIdx]);
		const distanceM = segmentDistance(streams, startIdx, endIdx);
		return {
			type,
			startIdx,
			endIdx,
			startTime: t[startIdx],
			endTime: t[endIdx],
			seconds,
			startAlt: alt[startIdx],
			endAlt: alt[endIdx],
			vertical: Math.abs(alt[endIdx] - alt[startIdx]),
			distanceM,
			avgSpeedMs: distanceM != null && seconds > 0 ? distanceM / seconds : null,
		};
	});
}

/**
 * The run/lift/idle segments for a ski day: the saved override when the owner
 * has hand-corrected this activity, otherwise auto-detection. This is the single
 * entry point everything downstream uses (display, exertion), so a correction
 * lands everywhere at once.
 */
export function resolveSkiSegments(streams: SkiStreams, override?: SkiSegmentOverride[] | null): SkiSegment[] {
	if (!streams.time_s || !streams.altitude_m) return [];
	const raw = override && override.length ? overrideRawSegments(streams, override) : autoRawSegments(streams);
	return enrich(streams, coalesce(raw));
}

/** Auto-detection only — kept as the name the tests and any auto-only caller
 *  use. Equivalent to `resolveSkiSegments` with no override. */
export function detectSkiSegments(streams: SkiStreams): SkiSegment[] {
	return resolveSkiSegments(streams, null);
}

/** A `SkiSegment[]` reduced to the storable override shape — what the editor
 *  saves after the owner reclassifies rows. */
export function toOverride(segments: SkiSegment[]): SkiSegmentOverride[] {
	return segments.map((s) => ({ t0: Math.round(s.startTime), t1: Math.round(s.endTime), type: s.type }));
}

function segmentDistance(streams: SkiStreams, a: number, b: number): number | null {
	const d = streams.distance_m;
	if (d && d[a] != null && d[b] != null) return Math.max(0, d[b] - d[a]);
	const ll = streams.latlng;
	if (ll && ll[a] && ll[b]) {
		let sum = 0;
		for (let i = a + 1; i <= b; i++) {
			if (ll[i - 1] && ll[i]) sum += haversine(ll[i - 1], ll[i]);
		}
		return sum;
	}
	return null;
}

function haversine(a: [number, number], b: [number, number]): number {
	const R = 6371000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(b[0] - a[0]);
	const dLng = toRad(b[1] - a[1]);
	const lat1 = toRad(a[0]);
	const lat2 = toRad(b[0]);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function summarizeSki(segments: SkiSegment[]): SkiSummary {
	const runs = segments.filter((s) => s.type === 'run');
	const lifts = segments.filter((s) => s.type === 'lift');
	const runSeconds = runs.reduce((a, s) => a + s.seconds, 0);
	const liftSeconds = lifts.reduce((a, s) => a + s.seconds, 0);
	const total = segments.length ? segments[segments.length - 1].endTime - segments[0].startTime : 0;
	return {
		runCount: runs.length,
		liftCount: lifts.length,
		runSeconds,
		liftSeconds,
		otherSeconds: Math.max(0, total - runSeconds - liftSeconds),
		verticalM: runs.reduce((a, s) => a + s.vertical, 0),
		longestRunVerticalM: runs.reduce((a, s) => Math.max(a, s.vertical), 0),
	};
}

/**
 * The active-descent time and a per-sample mask of it — everything exertion.ts
 * needs to score a lift-served ski day on how long was actually spent skiing
 * down, not sitting on a lift. `activeSeconds` is the summed run duration;
 * `activeMask[i]` is true for samples inside a run, so a heart-rate rung (the
 * rare ski file that has HR) can be trimmed to descending samples the same way
 * the moving mask trims stopped ones. Returns null when there is no usable
 * altitude stream, so the caller falls back to its normal moving-time handling.
 */
export function skiActive(
	streams: SkiStreams,
	override?: SkiSegmentOverride[] | null,
): { activeSeconds: number; activeMask: boolean[]; runCount: number } | null {
	const t = streams.time_s;
	if (!t) return null;
	const segments = resolveSkiSegments(streams, override);
	if (segments.length === 0) return null;
	const n = streams.altitude_m?.length ?? 0;
	const moving = streams.moving;
	const mask = new Array<boolean>(n).fill(false);
	let activeSeconds = 0;
	let runCount = 0;
	// Sum time sample-by-sample rather than per-segment so a stop mid-run (a
	// chat at a trail junction, waiting for the group) is excluded — that time
	// is inside a run's altitude envelope but is not skiing. A dt above the cap
	// is a recording gap, not real time, and is dropped for the same reason the
	// GPX moving calc caps its own gaps.
	const MAX_GAP_S = 30;
	for (const s of segments) {
		if (s.type !== 'run') continue;
		runCount++;
		for (let i = s.startIdx; i < s.endIdx && i < n; i++) {
			mask[i] = true;
			if (moving && moving[i] === false) continue;
			const dt = t[i + 1] - t[i];
			if (dt > 0 && dt <= MAX_GAP_S) activeSeconds += dt;
		}
	}
	return { activeSeconds, activeMask: mask, runCount };
}
