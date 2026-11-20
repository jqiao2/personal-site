// Value: MTA Savant's answer to Savant's batting and baserunning run value. Run
// value counts runs above an average player, so it is quality times playing
// time; here it is rider-hours a month saved against the average line, so it is
// lost-or-saved minutes per rider times riders.
//
// Wait Value is the time off the vehicle (extra platform or stop wait beyond the
// schedule), Ride Value the time on it (extra minutes on board beyond the
// schedule). "Average" is rider-weighted across the mode, so a mode's values sum
// to zero, as run values do. The rider-hours are then scaled so the line
// furthest from average scores ±100: 0 is average, and gaps stay proportional.
import { rank, valueOf, type Dataset, type Mode, type Ranked } from './mta-savant';

export interface ValueStat {
	key: 'wait' | 'ride';
	label: string;
	title: string;
}

/** The per-rider minutes each value is built from, by mode. */
const RATE: Record<Mode, { wait: string; ride: string }> = {
	subway: { wait: 'apt', ride: 'att' },
	bus: { wait: 'abst', ride: 'att' },
};

export const VALUE_STATS: ValueStat[] = [
	{
		key: 'wait',
		label: 'Wait Value',
		title: 'Time riders save waiting for the train or bus against the average line, times riders; −100 to 100, 0 is average',
	},
	{
		key: 'ride',
		label: 'Ride Value',
		title: 'Time riders save on board against the average line, times riders; −100 to 100, 0 is average',
	},
];

/** Rider-hours a month above average, per line, for one rate over the window. */
function hoursAbove(ds: Dataset, rate: string, pick: (month: string) => boolean) {
	const lines = ds.lines.flatMap((l) => {
		const minutes = valueOf(ds, l.id, rate, pick);
		const riders = valueOf(ds, l.id, 'riders', pick);

		return minutes === null || riders === null ? [] : [{ id: l.id, minutes, riders }];
	});

	const total = lines.reduce((sum, l) => sum + l.riders, 0);
	const average = lines.reduce((sum, l) => sum + l.minutes * l.riders, 0) / total;

	return new Map(lines.map((l) => [l.id, ((average - l.minutes) * l.riders) / 60]));
}

const memo = new Map<string, Ranked>();

/** Ranked Wait or Ride Value for every line over the window. */
export function values(ds: Dataset, key: ValueStat['key'], window: string, pick: (month: string) => boolean): Ranked {
	const memoKey = `${ds.mode}|${key}|${window}`;
	const hit = memo.get(memoKey);

	if (hit) return hit;

	const hours = hoursAbove(ds, RATE[ds.mode][key], pick);
	const scale = Math.max(...[...hours.values()].map(Math.abs)) || 1;

	const out = rank(
		[...hours].map(([id, v]) => ({ id, v: (100 * v) / scale })),
		true
	);

	memo.set(memoKey, out);

	return out;
}

/** Signed whole number on the −100 to 100 scale: +54, −12, 0. */
export function formatValue(v: number) {
	const n = Math.round(v);

	return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}
