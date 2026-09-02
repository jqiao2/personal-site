// Physical exertion — §3 of ACTIVITIES.md. Pure functions over streams and
// thresholds; no database access, no I/O, so the whole `activities` table can
// be re-run through `computeExertion` in bulk whenever a threshold changes or
// a bug here is fixed, without touching the ingest pipeline at all.
//
// WHY THERE IS NO SINGLE FORMULA. The published methods for turning a workout
// into one number each assume an instrument this athlete doesn't uniformly
// have. Coggan's TSS needs a power meter — true for every ride, true for
// nothing else. Banister's TRIMP needs a heart-rate stream — true for runs
// and hikes, unavailable for a pool swim where the watch may log nothing but
// lap splits. rTSS/sTSS need a threshold pace and a clean distance+time, which
// a pace-only fun run or a snorkel-slow open-water swim may not cleanly give
// either. MET-minutes need only sport and duration, and that is exactly why
// it is the floor and not the answer: it knows nothing about how hard *this*
// effort actually was, only what the average bout of that sport costs. Any
// site that reports one "effort score" off one formula is silently doing one
// of two dishonest things: applying a power-based idea to a hike that has no
// power, or flattening a hard interval ride and an easy century into the
// same duration-only number. Neither is this athlete's data.
//
// WHY A CASCADE ONTO ONE SCALE INSTEAD OF FIVE SEPARATE FIELDS. The whole
// point of `exertion` (per ACTIVITIES.md's opening bullets) is to be the one
// axis a 4-hour endurance ride, a 40-minute threshold run and a 90-minute
// hike can be sorted and compared on at all — `/activities/all`'s exertion
// filter and sort (§8) only make sense if every row is on the same number
// line. So every method is normalised to the same TSS-equivalent: **an hour
// at that sport's functional threshold scores 100**, whether "threshold" for
// that hour was measured in watts, beats per minute, seconds per kilometre,
// or (at the floor) just inferred from what that sport typically costs an
// athlete of this build. The cascade tries the highest-fidelity method the
// activity's actual data supports and stops there — see the five rungs below.
//
// WHY THE METHOD AND CONFIDENCE ARE STORED NEXT TO THE NUMBER, NOT HIDDEN.
// A hike scored off a MET table and a ride scored off a 1Hz power file are
// answering the same question ("how hard was this, on the threshold-hour
// scale") with wildly different amounts of evidence, and collapsing that
// difference into a bare number is precisely what makes every other
// platform's "effort" or "training load" score untrustworthy — it invites you
// to compare two numbers that were never computed the same way. So
// `computeExertion` returns not just `score` but `method`, `confidence`
// (`'measured' | 'estimated' | 'assumed'`), and `detail` — a one-line human
// sentence ("4h12m at NP 218W against a 265W FTP") the UI can show right next
// to the number, so it is never presented as an unexplained claim. §3 is
// explicit that the UI must never show the number without a way to see how it
// was got; `detail` is that way.
//
// THE CASCADE, IN ORDER (§3):
//   1. power stream + FTP for that date        → tss     (measured)
//   2. HR stream + rest/max/LTHR for that date  → hrtss   (measured)
//   3. no streams, but avg HR + duration        → avghr   (estimated)
//   4. running/swimming with pace + threshold   → ptss    (estimated)
//  4.5 lift-served ski/board, active descent    → ski     (estimated)
//   5. sport + duration (+ distance, elevation) → met     (assumed)
// Each rung is tried only if the rung above it couldn't be computed from what
// the activity actually has — see `computeExertion`'s branches for exactly
// what "couldn't be computed" means at each step.
//
// THE SKI RUNG (4.5) is not a fourth intensity model — it is the MET floor with
// an honest duration. A resort day's file time is mostly chairlift, so scoring
// it needs the active-descent time first; `skiActive` (src/lib/ski.ts) recovers
// it from the altitude sawtooth, and for a ski day WITH heart rate the same
// active mask trims the HR rung above. See LIFT_SERVED below.
//
// WHY MOVING TIME, NEVER ELAPSED. A stopped watch at a café or a chairlift
// queue is not training stress; every formula below is handed
// `moving_seconds` (or a stream already filtered to moving samples), never
// `elapsed_seconds`. This is worth stating because it is the one rule a
// future edit to this file could silently break by reaching for the more
// obviously-named field.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { SPORTS, sportMeta } from './sports';
import { skiActive, type SkiSegmentOverride } from './ski';

// Lift-served snow sports: a resort day is mostly lift and lodge, and the file's
// duration (elapsed, or a Slopes-exported moving_seconds that is simply broken
// for this archive) reflects that, not the skiing. For these two, exertion is
// scored on the active-descent time recovered from the altitude stream — see
// the ski rung in computeExertion. Backcountry and nordic skiing are NOT here:
// their climbing is the effort, not a lift, so their whole moving time counts.
const LIFT_SERVED = new Set(['alpine_ski', 'snowboard']);

/** MET for time spent actually descending (lifts and stops already removed),
 *  distinct from sports.ts's whole-day ski MET which is deliberately low to
 *  average the lift in. Compendium downhill skiing runs 5.3 (moderate) to 8.0
 *  (vigorous); a resort lap of continuous turning sits in between. */
const ACTIVE_SKI_MET: Record<string, number> = { alpine_ski: 7, snowboard: 6 };

/** The threshold row "in force" on an activity's date — one row from
 *  `athlete_thresholds`, already resolved by `effective_from` before this is
 *  called (that resolution needs the database; this file only consumes the
 *  result). All nullable: a newer athlete, or a gap before the first entry,
 *  may not have every threshold recorded yet. */
export interface Thresholds {
	ftp_w: number | null;
	lthr_bpm: number | null;
	max_hr: number | null;
	rest_hr: number | null;
	threshold_pace_s_per_km: number | null;
	css_pace_s_per_100m: number | null;
	weight_kg: number | null;
}

/** Per-sample streams, already unpacked from the `activity_streams` JSONB
 *  columns. Every array is optional — a treadmill run may have heartrate but
 *  no altitude; a trainer ride has power but no distance. `moving` is a
 *  parallel boolean array (device-reported "not stopped"), used to trim the
 *  power/HR streams down to moving samples before they're fed to NP/TRIMP so
 *  a long stoplight doesn't drag either average down. */
export interface ExertionStreams {
	time_s?: number[];
	power_w?: number[];
	heartrate?: number[];
	altitude_m?: number[];
	distance_m?: number[];
	moving?: boolean[];
}

/** What `computeExertion` needs off one `activities` row. Field names match
 *  the DB columns (minus the `avg_` / no prefix on sport) so a caller can
 *  mostly spread a row in directly. */
export interface ExertionInput {
	sport: string;
	moving_seconds: number | null;
	elapsed_seconds: number | null;
	distance_m: number | null;
	elevation_gain_m: number | null;
	avg_hr: number | null;
	avg_power_w: number | null;
	streams?: ExertionStreams;
	/** A hand-corrected run/lift partition for a ski day (the `ski_segments`
	 *  column). When present it replaces auto-detection, so the score reflects
	 *  the owner's correction — a lift they actually hiked now counts as descent. */
	ski_segments?: SkiSegmentOverride[] | null;
}

export type ExertionMethod = 'tss' | 'hrtss' | 'avghr' | 'ptss' | 'met' | 'ski';
export type ExertionConfidence = 'measured' | 'estimated' | 'assumed';

export interface ExertionResult {
	/** TSS-equivalent, ~0–500 in practice (a 500 would be a multi-day event —
	 *  nothing here clamps it, because clamping would silently lie about an
	 *  ultra). An hour at threshold is 100, by construction of every method
	 *  below. */
	score: number;
	method: ExertionMethod;
	confidence: ExertionConfidence;
	/** NP/FTP for `tss`, HR-reserve-based for `hrtss`/`avghr`, pace-based for
	 *  `ptss`. `null` for `met`, which has no intensity axis — only a duration
	 *  and a sport-average cost. */
	intensityFactor: number | null;
	/** One human sentence justifying the number — see header comment. Always
	 *  present, even at the `met` floor, so the UI never has to fall back to
	 *  showing the bare score. */
	detail: string;
}

// ---------------------------------------------------------------------------
// Normalized power
// ---------------------------------------------------------------------------

/**
 * Coggan's normalized power: a 30-second rolling average of the power
 * stream, raised to the 4th power, averaged over the activity, then
 * 4th-rooted. The 30s window and the 4th power aren't arbitrary — they're
 * fit to how quickly the body's anaerobic contribution decays and how much
 * more a spike above threshold costs than time at threshold, which is the
 * whole reason NP exists instead of just using average power: a ride with
 * hard 2-minute pulls and easy recovery costs more than its average watts
 * suggest, and NP is the published correction for that.
 *
 * Needs a genuinely time-ordered, roughly-1Hz stream to build 30-second
 * windows from — `timeStream` supplies the seconds-from-start each power
 * sample belongs to, so this still works on a stream with gaps or a
 * non-1Hz recording rate (a device that only logs on change, say), rather
 * than assuming one sample per second.
 */
export function normalizedPower(powerStream: number[], timeStream: number[]): number | null {
	if (powerStream.length === 0 || powerStream.length !== timeStream.length) return null;

	const windowSeconds = 30;
	const rolling: number[] = [];
	let windowStart = 0;
	let windowSum = 0;
	let windowCount = 0;

	// Sliding window over time, not over index — a dropped-sample gap must
	// widen the window's sample count rather than silently averaging fewer,
	// more-distant-in-time points as if they were 30 contiguous seconds.
	for (let i = 0; i < powerStream.length; i++) {
		windowSum += powerStream[i];
		windowCount++;
		while (timeStream[i] - timeStream[windowStart] > windowSeconds) {
			windowSum -= powerStream[windowStart];
			windowCount--;
			windowStart++;
		}
		rolling.push(windowSum / windowCount);
	}

	if (rolling.length === 0) return null;
	const meanFourth = rolling.reduce((sum, w) => sum + w ** 4, 0) / rolling.length;
	return meanFourth ** 0.25;
}

// ---------------------------------------------------------------------------
// TSS family
// ---------------------------------------------------------------------------

export interface TssInput {
	seconds: number;
	np: number;
	ftp: number;
}

/** Coggan's TSS: `(seconds * NP * IF) / (FTP * 3600) * 100`, where
 *  `IF = NP / FTP`. This is the cascade's rung 1 and the definition every
 *  other rung is rescaled to match — an hour (3600s) at NP == FTP (IF == 1)
 *  gives exactly 100 by construction. */
export function tss({ seconds, np, ftp }: TssInput): number {
	if (ftp <= 0) return 0;
	const intensityFactor = np / ftp;
	return (seconds * np * intensityFactor) / (ftp * 3600) * 100;
}

// ---------------------------------------------------------------------------
// Banister TRIMP
// ---------------------------------------------------------------------------

export interface TrimpInput {
	/** Either a per-sample HR stream (preferred — integrates true variation)
	 *  or a flat average HR for the activity (coarser: TRIMP's exponential
	 *  weighting is applied to one number instead of many, so a hard interval
	 *  session and a steady ride at the same average HR come out identical
	 *  even though they weren't equally hard — this is exactly the
	 *  measured-vs-estimated distinction the cascade tracks in `confidence`). */
	hrStream?: number[];
	avgHr?: number;
	seconds: number;
	restHr: number;
	maxHr: number;
}

/** Banister's TRIMP, male-coefficient form (this athlete):
 *  `minutes * ΔHRr * 0.64 * e^(1.92 * ΔHRr)`, where `ΔHRr` is heart-rate
 *  reserve fraction `(hr - restHr) / (maxHr - restHr)`. The exponential
 *  weighting is the point of using Banister over an unweighted average: a
 *  minute at 90% HRR is worth much more than a minute at 60%, the way a
 *  minute at 90% FTP is worth much more than 60% in the power world — TRIMP
 *  is HR's analogue to NP's 4th-power weighting, both trying to capture that
 *  intensity costs faster than it averages.
 *
 *  When `hrStream` is given, this integrates second-by-second (in effect,
 *  1-second "minutes") for a true accumulation; with only `avgHr` it applies
 *  the same formula once to the whole duration at that flat average. */
export function banisterTrimp({ hrStream, avgHr, seconds, restHr, maxHr }: TrimpInput): number | null {
	const reserve = maxHr - restHr;
	if (reserve <= 0) return null;

	const weight = (hr: number) => {
		const hrr = clamp01((hr - restHr) / reserve);
		return hrr * 0.64 * Math.exp(1.92 * hrr);
	};

	if (hrStream && hrStream.length > 0) {
		// Integrate per-sample, assuming the stream's samples are ~evenly
		// spaced across `seconds` (true for the moving-filtered 1Hz-ish
		// streams this is fed). Each sample stands for an equal slice of the
		// activity's moving time.
		const secondsPerSample = seconds / hrStream.length;
		let total = 0;
		for (const hr of hrStream) total += weight(hr) * (secondsPerSample / 60);
		return total;
	}

	if (avgHr != null) {
		return weight(avgHr) * (seconds / 60);
	}

	return null;
}

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

/**
 * Rescales a raw TRIMP value onto the TSS-equivalent scale: an hour spent
 * entirely at LTHR (HRR fraction `ΔHRr_lthr`) must equal 100. That reference
 * TRIMP-per-hour is `60 * weight(LTHR-as-HRR)`; `trimpToTss` is just the
 * ratio of the activity's TRIMP to that reference, times 100. This is what
 * turns "a TRIMP number" (whose raw magnitude means nothing on its own —
 * Banister never intended it as a 0–100 scale) into `hrtss`/`avghr`'s
 * contribution to `exertion`, which by contract always means "percent of a
 * threshold-hour."
 */
export function trimpToTss(trimp: number, lthrBpm: number, restHr: number, maxHr: number): number | null {
	const reserve = maxHr - restHr;
	if (reserve <= 0) return null;
	const lthrHrr = clamp01((lthrBpm - restHr) / reserve);
	const referenceTrimpPerHour = 60 * lthrHrr * 0.64 * Math.exp(1.92 * lthrHrr);
	if (referenceTrimpPerHour <= 0) return null;
	return (trimp / referenceTrimpPerHour) * 100;
}

// ---------------------------------------------------------------------------
// Grade-adjusted pace (running / hiking)
// ---------------------------------------------------------------------------

/**
 * Minetti's cost-of-running polynomial (Minetti et al. 2002), converting a
 * fractional grade to the metabolic-cost multiplier of running that grade
 * versus flat ground. Chosen over a linear "add N seconds per 100ft of
 * climb" fudge because it is the one grade-cost curve derived from actual
 * metabolic-gas measurement across a full grade range (-45% to +45%), and
 * because it is *not* symmetric — it correctly costs a steep descent more
 * than flat ground too (eccentric braking has a real metabolic cost), where
 * a naive climb-only adjustment would score a technical, quad-burning
 * downhill trail run as free speed.
 *
 * `Cr(grade) = 155.4g^5 - 30.4g^4 - 43.3g^3 + 46.3g^2 + 19.5g + 3.6`
 * (kcal per kg per km), normalised here to a multiplier by dividing by the
 * flat-ground value `Cr(0) = 3.6`.
 */
export function gradeCostMultiplier(grade: number): number {
	const g = clamp(grade, -0.45, 0.45); // outside Minetti's measured range; clamp rather than extrapolate
	const cr =
		155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
	return cr / 3.6;
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, x));
}

/** Grade-adjusted equivalent flat speed: running `speedMs` at `grade`
 *  (fractional, e.g. 0.05 for 5%) costs the same energy as running this
 *  speed on flat ground. Used to fold a hilly run's climbing into a single
 *  pace comparable against a threshold pace measured on the flat. */
export function gradeAdjustedPace(speedMs: number, grade: number): number {
	return speedMs * gradeCostMultiplier(grade);
}

// ---------------------------------------------------------------------------
// pace-based TSS (running / swimming)
// ---------------------------------------------------------------------------

export interface RunningTssInput {
	seconds: number;
	/** Average pace already grade-adjusted if elevation data was available —
	 *  see `gradeAdjustedPace`. Seconds per kilometre. */
	gradeAdjustedPaceSPerKm: number;
	thresholdPaceSPerKm: number;
}

/** rTSS: pace's analogue of power-based TSS. Because pace is inverse to
 *  effort (a *smaller* number is faster), intensity factor is
 *  `threshold / actual`, the reciprocal of the power-side ratio — get this
 *  backwards and every run scores as harder the slower it went. */
export function runningTss({ seconds, gradeAdjustedPaceSPerKm, thresholdPaceSPerKm }: RunningTssInput): number {
	if (gradeAdjustedPaceSPerKm <= 0 || thresholdPaceSPerKm <= 0) return 0;
	const intensityFactor = thresholdPaceSPerKm / gradeAdjustedPaceSPerKm;
	return (seconds * intensityFactor ** 2) / 3600 * 100;
}

export interface SwimTssInput {
	seconds: number;
	avgPaceSPer100m: number;
	cssPaceSPer100m: number;
}

/** sTSS: same shape as rTSS, against CSS (critical swim speed) instead of a
 *  running threshold pace. Pool swimming is the one sport in this section
 *  where a device may hand back only lap-derived pace with no continuous
 *  stream (§3's "watch may record nothing but laps"), so this rung is
 *  deliberately pace-only rather than trying to integrate a stream that
 *  usually won't exist. */
export function swimTss({ seconds, avgPaceSPer100m, cssPaceSPer100m }: SwimTssInput): number {
	if (avgPaceSPer100m <= 0 || cssPaceSPer100m <= 0) return 0;
	const intensityFactor = cssPaceSPer100m / avgPaceSPer100m;
	return (seconds * intensityFactor ** 2) / 3600 * 100;
}

// ---------------------------------------------------------------------------
// MET floor
// ---------------------------------------------------------------------------

/** Built from sports.ts's SPORT_META so callers who only want "the MET
 *  table" (the scratch-test / bulk-recompute use case) don't have to import
 *  two modules and reassemble it themselves. sports.ts is the source of
 *  truth (see that file's header comment for why this table lives there and
 *  not here) — this is a flattened view onto it, computed once at module
 *  load rather than duplicated by hand, so the two can never drift apart. */
export const MET_TABLE: Record<string, number> = Object.fromEntries(
	SPORTS.map((sport) => [sport, sportMeta(sport).met]),
);

export interface MetMinutesInput {
	sport: string;
	seconds: number;
	distance_m: number | null;
	elevation_gain_m: number | null;
}

/**
 * MET-minutes: the floor rung, needing nothing but sport and duration.
 * `MET-minutes = MET * (seconds / 60)`, the standard Compendium definition.
 * Distance and elevation are accepted but only nudge the MET value where the
 * Compendium itself makes that distinction (steeper effective pace/climb
 * rate = harder), rather than inventing a continuous correction the
 * Compendium doesn't define — see the adjustment comments inline.
 */
export function metMinutes({ sport, seconds, distance_m, elevation_gain_m }: MetMinutesInput): number {
	let met = sportMeta(sport).met;

	// Elevation-rate bump for foot sports: the Compendium's hiking entries
	// step up with grade (its own table has separate rows for "hiking,
	// cross-country" at ~6 MET and "hiking, climbing hills, >20kg load" well
	// above 9). Rather than hardcode a second sport-specific MET, approximate
	// that same step using a measured climb rate, since that's the variable
	// the Compendium itself keys off.
	const family = sportMeta(sport).family;
	if ((family === 'foot' || sport === 'backcountry_ski') && distance_m && elevation_gain_m && seconds > 0) {
		const hours = seconds / 3600;
		const climbRateMPerHour = elevation_gain_m / hours;
		// ~300m/hr is a genuinely steep sustained trail climb; scale the MET up
		// smoothly rather than stepping, since a discrete jump would make two
		// nearly-identical hikes score very differently right at the boundary.
		const climbBump = Math.min(1, climbRateMPerHour / 600);
		met = met * (1 + 0.35 * climbBump);
	}

	return met * (seconds / 60);
}

/**
 * Converts MET-minutes to the TSS-equivalent scale. There is no published
 * "MET-TSS" — this is the cascade's own bridge, and it is deliberately the
 * crudest step in the file, which is exactly why `met` is always marked
 * `'assumed'` rather than `'estimated'` or `'measured'`.
 *
 * The anchor: this athlete's FTP effort is itself a MET-scale intensity too
 * (roughly 12 MET at a serious threshold power output for someone this
 * build), so "100 at an hour of threshold" translates to "100 at an hour of
 * ~12 MET-equivalent effort" — i.e. `TSS-equivalent = MET-minutes * (100/60) / 12`.
 * `restMet` (1 MET, sitting still) is subtracted first so an activity isn't
 * credited training stress for the resting metabolism it would have burned
 * anyway — the same logic the Compendium itself uses when it calls MET a
 * *multiple of resting* metabolic rate.
 */
export function metToTss(metMinutesValue: number, minutes: number): number {
	const THRESHOLD_MET = 12; // see comment above — this file's own anchor, not a published constant
	const REST_MET = 1;
	const activeMetMinutes = metMinutesValue - REST_MET * minutes;
	return Math.max(0, (activeMetMinutes / THRESHOLD_MET / 60) * 100);
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

function filterMoving<T>(values: T[] | undefined, moving: boolean[] | undefined): T[] | undefined {
	if (!values) return undefined;
	if (!moving || moving.length !== values.length) return values;
	const out: T[] = [];
	for (let i = 0; i < values.length; i++) if (moving[i]) out.push(values[i]);
	return out;
}

function formatDurationShort(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	if (h > 0) return `${h}h${m > 0 ? `${m}m` : ''}`;
	return `${m}m`;
}

/**
 * Walks the §3 cascade, in order, taking the best method the activity's data
 * supports. Every branch below states in a comment exactly what "the data
 * supports it" is checked as, so a future change to what counts as
 * sufficient data is a one-line diff against a stated rule rather than a
 * guess about what the original author meant.
 */
export function computeExertion(input: ExertionInput, thresholds: Thresholds): ExertionResult {
	const streams = input.streams;

	// A lift-served ski/snowboard day is re-timed to its active descent before
	// anything below runs: `skiActive` segments the altitude sawtooth into runs
	// and lifts and returns the summed run time and a per-sample mask of it.
	// From here on `movingSeconds` IS that active-descent time and `movingMask`
	// marks the descending samples, so every rung — the HR rung a ski day with a
	// strap reaches, and the ski MET rung the rest fall to — scores the skiing
	// and not the chairlift. Null (no altitude, or no run detected) falls back to
	// the file's own moving time, exactly as every other sport uses it.
	let ski = LIFT_SERVED.has(input.sport) && streams ? skiActive(streams, input.ski_segments) : null;
	if (ski && ski.activeSeconds <= 0) ski = null;
	const movingSeconds = ski ? ski.activeSeconds : input.moving_seconds ?? input.elapsed_seconds ?? 0;
	const movingMask = ski ? ski.activeMask : streams?.moving;

	// --- Rung 1: power stream + FTP -----------------------------------------
	// "Power stream" means an actual 1Hz-ish power_w array with a matching
	// time_s array long enough to build at least one 30s NP window (20
	// samples, arbitrarily: shorter than that and NP degenerates toward
	// simple average anyway, so there's nothing rung 1 offers over rung 3
	// that's worth the extra complexity).
	// Gated on the BIKE family, not merely on "there is a power stream". FTP is
	// a cycling threshold, and a running watch also reports watts — but running
	// power is a different quantity on a different scale, and dividing it by a
	// cycling FTP is a unit error wearing a plausible-looking number. Ungated,
	// this archive's runs scored an average of 187 TSS and a maximum of 971,
	// against a definition where an hour at threshold is 100. Runs with power
	// fall through to the HR rungs, which are true for them.
	if (sportMeta(input.sport).family === 'bike' && streams?.power_w && streams.time_s && thresholds.ftp_w) {
		const power = filterMoving(streams.power_w, movingMask) ?? streams.power_w;
		const time = filterMoving(streams.time_s, movingMask) ?? streams.time_s;
		if (power.length >= 20 && power.length === time.length) {
			const np = normalizedPower(power, time);
			if (np != null) {
				const score = tss({ seconds: movingSeconds, np, ftp: thresholds.ftp_w });
				const intensityFactor = np / thresholds.ftp_w;
				return {
					score,
					method: 'tss',
					confidence: 'measured',
					intensityFactor,
					detail: `${formatDurationShort(movingSeconds)} at NP ${Math.round(np)}W against a ${thresholds.ftp_w}W FTP (IF ${intensityFactor.toFixed(2)})`,
				};
			}
		}
	}
	// Power stream present but no FTP on file, or an average-only power
	// column with no stream: fall through rather than silently using
	// avg_power_w as if it were NP — that would be exactly the
	// average-vs-normalized conflation the header comment argues NP exists to
	// fix, and it would be reported as 'measured' when it isn't. If there's an
	// HR stream instead, rungs 2-3 pick it up next; a power-only activity with
	// no FTP and no HR falls all the way to the MET floor, which is correct:
	// there is genuinely no threshold to compare that power file against yet.

	// --- Rung 2: HR stream + rest/max/LTHR ----------------------------------
	if (
		streams?.heartrate &&
		streams.heartrate.length >= 20 &&
		thresholds.rest_hr != null &&
		thresholds.max_hr != null &&
		thresholds.lthr_bpm != null
	) {
		const hr = filterMoving(streams.heartrate, movingMask) ?? streams.heartrate;
		const trimp = banisterTrimp({
			hrStream: hr,
			seconds: movingSeconds,
			restHr: thresholds.rest_hr,
			maxHr: thresholds.max_hr,
		});
		if (trimp != null) {
			const score = trimpToTss(trimp, thresholds.lthr_bpm, thresholds.rest_hr, thresholds.max_hr);
			if (score != null) {
				const avgOfStream = hr.reduce((s, v) => s + v, 0) / hr.length;
				return {
					score,
					method: 'hrtss',
					confidence: 'measured',
					intensityFactor: score / 100,
					detail: `${formatDurationShort(movingSeconds)}, avg HR ${Math.round(avgOfStream)} against an LTHR of ${thresholds.lthr_bpm}`,
				};
			}
		}
	}

	// --- Rung 3: no streams, but a flat average HR --------------------------
	if (
		input.avg_hr != null &&
		thresholds.rest_hr != null &&
		thresholds.max_hr != null &&
		thresholds.lthr_bpm != null &&
		movingSeconds > 0
	) {
		const trimp = banisterTrimp({
			avgHr: input.avg_hr,
			seconds: movingSeconds,
			restHr: thresholds.rest_hr,
			maxHr: thresholds.max_hr,
		});
		if (trimp != null) {
			const score = trimpToTss(trimp, thresholds.lthr_bpm, thresholds.rest_hr, thresholds.max_hr);
			if (score != null) {
				return {
					score,
					method: 'avghr',
					confidence: 'estimated',
					intensityFactor: score / 100,
					detail: `${formatDurationShort(movingSeconds)} at a flat average HR of ${input.avg_hr} against an LTHR of ${thresholds.lthr_bpm} (no HR stream, so this is one average applied to the whole activity rather than integrated)`,
				};
			}
		}
	}

	// --- Rung 4: running/swimming with pace + threshold ---------------------
	// Gated on sport *family*, not on `paceStyle` — a hike also reports a
	// per-km pace (§6 shows it as a stat), but §3 names this rung
	// "running/swimming" specifically, and a hike's plausible pace range has
	// nothing to do with a runner's threshold pace. A hike with no HR data
	// falls straight through to the MET floor instead, which is the honest
	// answer: there is no hiking-pace threshold in `Thresholds` to compare it
	// against.
	const meta = sportMeta(input.sport);
	if (movingSeconds > 0 && input.distance_m && input.distance_m > 0) {
		if (meta.family === 'swim' && thresholds.css_pace_s_per_100m) {
			const avgPaceSPer100m = (movingSeconds / input.distance_m) * 100;
			const score = swimTss({
				seconds: movingSeconds,
				avgPaceSPer100m,
				cssPaceSPer100m: thresholds.css_pace_s_per_100m,
			});
			return {
				score,
				method: 'ptss',
				confidence: 'estimated',
				intensityFactor: thresholds.css_pace_s_per_100m / avgPaceSPer100m,
				detail: `${formatDurationShort(movingSeconds)} averaging ${formatPace(avgPaceSPer100m)}/100m against a CSS of ${formatPace(thresholds.css_pace_s_per_100m)}/100m`,
			};
		}
		if (meta.family === 'run' && thresholds.threshold_pace_s_per_km) {
			const avgSpeedMs = input.distance_m / movingSeconds;
			// Grade-adjust only when there's elevation to adjust for; an
			// ungraded pace against a flat threshold is still a fair
			// comparison for a flat run, just not for a hilly one — and
			// without elevation data there is no adjustment to make anyway.
			const distanceKm = input.distance_m / 1000;
			const grade =
				input.elevation_gain_m && distanceKm > 0 ? input.elevation_gain_m / (distanceKm * 1000) : 0;
			const adjustedSpeedMs = grade ? gradeAdjustedPace(avgSpeedMs, grade) : avgSpeedMs;
			const adjustedPaceSPerKm = adjustedSpeedMs > 0 ? 1000 / adjustedSpeedMs : 0;
			if (adjustedPaceSPerKm > 0) {
				const score = runningTss({
					seconds: movingSeconds,
					gradeAdjustedPaceSPerKm: adjustedPaceSPerKm,
					thresholdPaceSPerKm: thresholds.threshold_pace_s_per_km,
				});
				return {
					score,
					method: 'ptss',
					confidence: 'estimated',
					intensityFactor: thresholds.threshold_pace_s_per_km / adjustedPaceSPerKm,
					detail: `${formatDurationShort(movingSeconds)} covering ${(input.distance_m / 1000).toFixed(1)}km${
						grade ? ', grade-adjusted' : ''
					} against a threshold pace of ${formatPace(thresholds.threshold_pace_s_per_km)}/km`,
				};
			}
		}
	}

	// --- Rung 4.5: lift-served snow, on active-descent time ------------------
	// Reached only when a ski/snowboard day has no HR strap (almost all of
	// them) — the HR rungs above already used the active mask when a strap was
	// present. `movingSeconds` is the run time, lifts and stops removed, so this
	// is the honest MET-minutes of the skiing itself, marked 'estimated' rather
	// than 'assumed' because the duration was measured off the altitude stream,
	// not taken from a sport-average. Uses the active-descent MET, not sports.ts's
	// deliberately-low whole-day ski MET.
	if (ski) {
		const skiMinutes = ski.activeSeconds / 60;
		const met = ACTIVE_SKI_MET[input.sport] ?? 7;
		const runs = ski.runCount;
		return {
			score: metToTss(met * skiMinutes, skiMinutes),
			method: 'ski',
			confidence: 'estimated',
			intensityFactor: null,
			detail: `${formatDurationShort(ski.activeSeconds)} of active descent across ${runs} run${
				runs === 1 ? '' : 's'
			} at ${met} MET — lift rides and stops excluded`,
		};
	}

	// --- Rung 5: MET floor ---------------------------------------------------
	// Always computable — sport and duration are the two fields every
	// activity row has by definition (§5's schema has both `not null`), so
	// this rung never fails to return, which is the point of calling it the
	// floor.
	const minutes = movingSeconds / 60;
	const rawMetMinutes = metMinutes({
		sport: input.sport,
		seconds: movingSeconds,
		distance_m: input.distance_m,
		elevation_gain_m: input.elevation_gain_m,
	});
	const score = metToTss(rawMetMinutes, minutes);
	return {
		score,
		method: 'met',
		confidence: 'assumed',
		intensityFactor: null,
		detail: `${formatDurationShort(movingSeconds)} of ${meta.label.toLowerCase()} at ${meta.met.toFixed(
			1,
		)} MET (no power, HR, or pace data — estimated from duration and sport alone)`,
	};
}

function formatPace(secPerUnit: number): string {
	const s = Math.round(secPerUnit);
	const m = Math.floor(s / 60);
	const ss = String(s % 60).padStart(2, '0');
	return `${m}:${ss}`;
}
