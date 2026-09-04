// Heart-rate and power zones — the time-in-zone breakdown on the detail page.
//
// WHY THESE TWO MODELS AND NOT SOMETHING BESPOKE. Both are anchored on the
// thresholds `athlete_thresholds` already records, so a zone reads on the same
// axis the exertion score (§3) is already built on rather than inventing a
// second, disagreeing notion of "hard":
//
//   - Power: Coggan's 7-zone % FTP — the universal cycling standard. Uses
//     `ftp_w`, and (like exertion.ts's power rung) is BIKE-ONLY: a running
//     watch reports watts on a different scale, and slicing them against a
//     cycling FTP is a unit error wearing a plausible number.
//   - Heart rate: Friel's % LTHR, collapsed from his 5a/5b/5c into one Z5 so
//     the display is five legible bars, not seven. LTHR is the same anchor the
//     HR exertion rung rescales to (an hour at LTHR == 100), so Z4/Z5 line up
//     with "a threshold hour" exactly as the score does.
//
// WHY TIME-WEIGHTED, NOT A SAMPLE COUNT. A device may log at 1 Hz, or on
// change, or drop samples across a pause. Counting samples per zone would then
// weight a densely-recorded climb over a sparsely-recorded descent. So each
// sample is credited the real time until the next one (capped, so an autopause
// gap can't dump minutes into whichever zone happened to be recorded on either
// side of it) — the same reason normalizedPower slides its window over time
// and not over index.
//
// Pure functions over arrays: no DB, no I/O, same as exertion.ts, so this can
// be unit-tested and re-run freely.

/** One zone boundary. `loPct` is its lower edge as a percent of the threshold
 *  (FTP for power, LTHR for HR), inclusive; the zone runs up to the next
 *  zone's `loPct` (exclusive), and the last zone is open-ended. */
export interface Zone {
	z: number;
	label: string;
	loPct: number;
}

/** Coggan's classic 7 power zones, as a percent of FTP. */
export const POWER_ZONES: Zone[] = [
	{ z: 1, label: 'Active recovery', loPct: 0 },
	{ z: 2, label: 'Endurance', loPct: 56 },
	{ z: 3, label: 'Tempo', loPct: 76 },
	{ z: 4, label: 'Threshold', loPct: 91 },
	{ z: 5, label: 'VO₂max', loPct: 106 },
	{ z: 6, label: 'Anaerobic', loPct: 121 },
	{ z: 7, label: 'Neuromuscular', loPct: 151 },
];

/** Friel's HR zones as a percent of LTHR, his 5a/5b/5c folded into one Z5. */
export const HR_ZONES: Zone[] = [
	{ z: 1, label: 'Recovery', loPct: 0 },
	{ z: 2, label: 'Aerobic', loPct: 81 },
	{ z: 3, label: 'Tempo', loPct: 90 },
	{ z: 4, label: 'Threshold', loPct: 94 },
	{ z: 5, label: 'Anaerobic', loPct: 100 },
];

export interface ZoneBin {
	zone: Zone;
	/** Absolute lower bound in the stream's own unit (bpm / W), inclusive. */
	lo: number;
	/** Absolute upper bound (exclusive); null for the open-ended top zone. */
	hi: number | null;
	seconds: number;
}

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Seconds each sample stands for. The gap to the next sample, with the last
 *  sample given the median gap; each capped so an autopause jump in the time
 *  channel (a 20-minute stop shows up as one 1200s step) can't be credited to
 *  a single zone. Falls back to 1s/sample when there's no usable time stream. */
function sampleIntervals(timeStream: number[] | null | undefined, n: number): number[] {
	if (!timeStream || timeStream.length !== n || n === 0) return new Array(n).fill(1);
	const raw = new Array<number>(n);
	const deltas: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		const d = timeStream[i + 1] - timeStream[i];
		raw[i] = d > 0 ? d : 0;
		if (d > 0) deltas.push(d);
	}
	const med = median(deltas) || 1;
	raw[n - 1] = med;
	// ponytail: cap at 4× the median gap (min 3s) to swallow pause jumps;
	// widen if a device ever logs legitimately irregular multi-second intervals.
	const cap = Math.max(4 * med, 3);
	return raw.map((d) => Math.min(d, cap));
}

/**
 * Accumulate stream time into zones. `threshold` is FTP (for POWER_ZONES) or
 * LTHR (for HR_ZONES). Returns one bin per zone with its absolute bounds and
 * seconds spent, or null when there's nothing to bin (no threshold, empty
 * stream, or every sample missing).
 */
export function timeInZones(
	values: (number | null | undefined)[],
	timeStream: number[] | null | undefined,
	threshold: number,
	zones: Zone[],
): ZoneBin[] | null {
	if (!(threshold > 0) || values.length === 0 || zones.length === 0) return null;
	const dt = sampleIntervals(timeStream, values.length);
	const seconds = new Array<number>(zones.length).fill(0);
	let any = false;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (typeof v !== 'number' || !Number.isFinite(v)) continue;
		const pct = (100 * v) / threshold;
		let zi = 0;
		for (let z = 0; z < zones.length; z++) if (zones[z].loPct <= pct) zi = z;
		seconds[zi] += dt[i];
		any = true;
	}
	if (!any) return null;
	return zones.map((zone, i) => ({
		zone,
		lo: Math.round((threshold * zone.loPct) / 100),
		hi: i + 1 < zones.length ? Math.round((threshold * zones[i + 1].loPct) / 100) : null,
		seconds: seconds[i],
	}));
}
