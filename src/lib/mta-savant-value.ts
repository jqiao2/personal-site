// Value: MTA Savant's answer to Savant's batting and baserunning run value. Run
// value counts runs above an average player, so it is quality times playing
// time; here it is rider-hours a month saved against the average line, so it is
// lost-or-saved minutes per rider times riders.
//
// Wait Value is the time off the vehicle (extra platform or stop wait beyond the
// schedule), Ride Value the time on it (extra minutes on board beyond the
// schedule). "Average" is rider-weighted across the mode, so a mode's values sum
// to zero, as run values do.
import { rank, valueOf, type Dataset, type Mode, type Ranked } from './mta-savant';

export interface ValueStat {
	key: string;
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
		title: 'Rider-hours a month saved waiting for the train or bus, against the average line',
	},
	{
		key: 'ride',
		label: 'Ride Value',
		title: 'Rider-hours a month saved on board, against the average line',
	},
	{ key: 'net', label: 'Net Value', title: 'Wait Value plus Ride Value' },
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

/** Ranked Wait, Ride and Net Value for every line over the window. */
export function values(ds: Dataset, key: string, window: string, pick: (month: string) => boolean): Ranked {
	const memoKey = `${ds.mode}|${key}|${window}`;
	const hit = memo.get(memoKey);

	if (hit) return hit;

	const wait = hoursAbove(ds, RATE[ds.mode].wait, pick);
	const ride = hoursAbove(ds, RATE[ds.mode].ride, pick);
	const pickFrom = key === 'wait' ? wait : key === 'ride' ? ride : null;

	const vals = pickFrom
		? [...pickFrom].map(([id, v]) => ({ id, v }))
		: [...wait].flatMap(([id, w]) => {
				const r = ride.get(id);

				return r === undefined ? [] : [{ id, v: w + r }];
			});

	const out = rank(vals, true);

	memo.set(memoKey, out);

	return out;
}

/** Signed, compact rider-hours: +12.3k, −840. */
export function formatValue(v: number) {
	const sign = v > 0.5 ? '+' : v < -0.5 ? '−' : '';
	const a = Math.abs(v);

	return sign + (a >= 1000 ? `${(a / 1000).toFixed(1)}k` : Math.round(a).toLocaleString('en-US'));
}
