// Ride and Wait Value: MTA Savant's offensive and defensive WAR. WAR sums every
// part of a player's game in one currency (runs), measures it against a
// replacement-level player, and scales it by playing time. So here:
//
// - Every stat is sorted onto one side. Ride Value (offense) is what happens on
//   board; Wait Value (defense) is everything before boarding.
// - The common currency is a z-score within the mode, sign-flipped where lower
//   is better, and a line's rate on a side is the mean of its z-scores there.
// - Replacement level is the 20th-percentile line's rate on that side.
// - Value = (rate − replacement) × riders, scaled so the best line is 100.
//   0 is a replacement-level line; below it goes negative.
//
// Journey on time (wJT%) spans both sides, so it is left out of both.
import { rank, valueOf, type Dataset, type Mode, type Ranked } from './mta-savant';

export interface ValueStat {
	key: 'ride' | 'wait';
	label: string;
	title: string;
}

/** Which metrics feed each side, by mode. */
const SIDES: Record<Mode, Record<ValueStat['key'], string[]>> = {
	subway: { ride: ['att', 'otp', 'delays', 'incidents'], wait: ['apt', 'wait', 'delivered', 'alerts'] },
	bus: { ride: ['att', 'speed'], wait: ['abst', 'wait', 'delivered'] },
};

// ponytail: equal weights and a fixed 20th-percentile replacement line; weight
// by how much each stat costs riders if the split ever feels off.
const REPLACEMENT_PCT = 0.2;

export const VALUE_STATS: ValueStat[] = [
	{
		key: 'ride',
		label: 'Ride Value',
		title: 'Offensive WAR: extra time on board, on-time arrivals, delays and incidents (bus: time on board, speed) against a replacement-level line, times riders; best line is 100',
	},
	{
		key: 'wait',
		label: 'Wait Value',
		title: 'Defensive WAR: extra platform wait, even gaps, service delivered and alerts (bus: stop wait, gaps, service) against a replacement-level line, times riders; best line is 100',
	},
];

/** Mean signed z-score per line over one side's metrics; lines missing a metric average the rest. */
function rates(ds: Dataset, keys: string[], pick: (month: string) => boolean) {
	const zs = new Map<string, number[]>();

	for (const key of keys) {
		const metric = ds.metrics.find((m) => m.key === key)!;

		const vals = ds.lines.flatMap((l) => {
			const v = valueOf(ds, l.id, key, pick);

			return v === null ? [] : [{ id: l.id, v }];
		});

		const mean = vals.reduce((sum, x) => sum + x.v, 0) / vals.length;
		const sd = Math.sqrt(vals.reduce((sum, x) => sum + (x.v - mean) ** 2, 0) / vals.length) || 1;

		for (const x of vals) {
			const z = ((x.v - mean) / sd) * (metric.higherIsBetter ? 1 : -1);

			(zs.get(x.id) ?? zs.set(x.id, []).get(x.id)!).push(z);
		}
	}

	return new Map([...zs].map(([id, list]) => [id, list.reduce((a, b) => a + b, 0) / list.length]));
}

const memo = new Map<string, Ranked>();

/** Ranked Ride or Wait Value for every line over the window. */
export function values(ds: Dataset, key: ValueStat['key'], window: string, pick: (month: string) => boolean): Ranked {
	const memoKey = `${ds.mode}|${key}|${window}`;
	const hit = memo.get(memoKey);

	if (hit) return hit;

	const rate = rates(ds, SIDES[ds.mode][key], pick);
	const sorted = [...rate.values()].sort((a, b) => a - b);
	const replacement = sorted[Math.floor(REPLACEMENT_PCT * (sorted.length - 1))];

	const raw = [...rate].flatMap(([id, r]) => {
		const riders = valueOf(ds, id, 'riders', pick);

		return riders === null ? [] : [{ id, v: (r - replacement) * riders }];
	});

	const best = Math.max(...raw.map((x) => x.v)) || 1;

	const out = rank(
		raw.map((x) => ({ id: x.id, v: (100 * x.v) / best })),
		true
	);

	memo.set(memoKey, out);

	return out;
}

/** Signed whole number, best line = 100: +54, −12, 0. */
export function formatValue(v: number) {
	const n = Math.round(v);

	return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}
