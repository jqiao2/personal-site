// The gear pages' arithmetic and vocabulary: what a component is, how worn it
// is, and how each number is said out loud.
//
// SEPARATE FROM gear.ts BECAUSE OF WHAT IT DOESN'T IMPORT. Everything here is
// pure — rides in, numbers out — so this module never touches a Supabase
// client and can therefore be imported by a plain-node script (see
// scripts/gear.test.mjs, which is the check on all of it). gear.ts owns the
// queries and re-exports this, so callers only ever import from gear.ts.
import type { GearKind } from './activities';
import { sportMeta } from './sports';

const METERS_PER_MILE = 1609.344;
/** Mean Gregorian month. The intervals below are "about three months", not
 * "about ninety days", and a fixed 30 would drift a fortnight over two years. */
const DAYS_PER_MONTH = 30.44;

// ---------------------------------------------------------------------------
// The component vocabulary. The DB check constraint in 0036 owns "is it one of
// these"; this owns everything else about them, so a label or an interval is
// changed in one place and no migration is needed to do it.
// ---------------------------------------------------------------------------

export type ComponentKind =
	| 'chain'
	| 'cassette'
	| 'chainrings'
	| 'brake_pads'
	| 'brake_rotors'
	| 'wheels'
	| 'tires'
	| 'sealant'
	| 'valves'
	| 'bar_tape'
	| 'cables'
	| 'bottom_bracket'
	| 'headset_bearings'
	| 'wheel_bearings'
	| 'cleats'
	| 'other';

export interface ComponentMeta {
	label: string;
	/** What the part actually wears against, said the way a mechanic says it. */
	trackBy: string;
	/** Typical replacement window in miles: [start worrying, replace it]. */
	lifeMiles?: [number, number];
	/** Typical replacement window in months, same two-sided reading. */
	lifeMonths?: [number, number];
	/**
	 * Set when the part only wears OUTDOORS, so indoor miles don't count
	 * against it.
	 *
	 * A trainer ride turns the cranks and the chain, so the drivetrain wears
	 * normally — but the bike isn't moving. The tires aren't rolling on road
	 * (they're off the bike, or on a trainer drum), the brakes are never
	 * touched, and the wheels and their bearings carry no load over anything.
	 * Counting a four-hour Zwift session against a tire's 2,000–5,000 mile
	 * window would retire a tire that hasn't touched tarmac.
	 */
	outdoorOnly?: true;
}

// The intervals are windows, not thresholds — a chain is not "dead at 3,000
// miles", it is somewhere between fine and finished across 2,000–4,000. The
// two numbers are read as "due" and "overdue" by wearOf() below, which is why
// nothing here is a single figure even where a single figure would look tidier.
export const COMPONENT_KINDS: Record<ComponentKind, ComponentMeta> = {
	chain: { label: 'Chain', trackBy: 'Miles', lifeMiles: [2000, 4000] },
	cassette: { label: 'Cassette', trackBy: 'Miles', lifeMiles: [5000, 15000] },
	chainrings: { label: 'Chainrings', trackBy: 'Miles', lifeMiles: [5000, 20000] },
	brake_pads: { outdoorOnly: true, label: 'Brake pads', trackBy: 'Miles + wear', lifeMiles: [1000, 5000] },
	brake_rotors: { outdoorOnly: true, label: 'Brake rotors', trackBy: 'Miles + thickness', lifeMiles: [5000, 15000] },
	// The wheel, not the bearings inside it — those are their own kind below,
	// because a wheelset outlives several sets of bearings and the two are
	// replaced for entirely different reasons. A disc-brake wheel has no
	// scheduled life at all (nothing rubs the rim), so it carries no interval.
	wheels: { outdoorOnly: true, label: 'Wheels', trackBy: 'Miles + condition' },
	tires: { outdoorOnly: true, label: 'Tires', trackBy: 'Miles', lifeMiles: [2000, 5000] },
	sealant: { label: 'Tubeless sealant', trackBy: 'Date added', lifeMonths: [3, 6] },
	valves: { label: 'Tubeless valves', trackBy: 'Condition' },
	bar_tape: { label: 'Bar tape', trackBy: 'Miles + date', lifeMonths: [12, 24] },
	cables: { label: 'Cables / housing', trackBy: 'Miles + date', lifeMonths: [12, 36] },
	bottom_bracket: { label: 'Bottom bracket', trackBy: 'Miles + symptoms' },
	headset_bearings: { label: 'Headset bearings', trackBy: 'Miles + symptoms' },
	wheel_bearings: { outdoorOnly: true, label: 'Wheel bearings', trackBy: 'Miles + symptoms' },
	// Not on the bike. It's here because the shoes it bolts to aren't tracked
	// as gear, and a cleat with no home is a cleat nobody replaces.
	cleats: { label: 'Cleats', trackBy: 'Miles + symptoms' },
	other: { label: 'Other', trackBy: 'Condition' },
};

/** Declaration order, which is roughly drivetrain → brakes → contact points →
 * bearings — the order a mechanic walks the bike, and the order the fitted
 * list is sorted into. */
export const COMPONENT_ORDER = Object.keys(COMPONENT_KINDS) as ComponentKind[];

export function isComponentKind(v: unknown): v is ComponentKind {
	return typeof v === 'string' && v in COMPONENT_KINDS;
}

/** The plural heading a gear kind sits under on the index. */
export const GEAR_KIND_LABELS: Record<GearKind, string> = {
	bike: 'Bikes',
	shoes: 'Shoes',
	skis: 'Skis',
	board: 'Boards',
	other: 'Other',
};

// ---------------------------------------------------------------------------
// Row shapes and the sums over them
// ---------------------------------------------------------------------------

export interface GearComponent {
	id: number;
	gear_id: number;
	kind: ComponentKind;
	label: string | null;
	installed_on: string;
	removed_on: string | null;
	baseline_distance_m: number;
	/** Per-instance replacement window overriding this kind's default (0037).
	 * `[due, overdue]`, or null to use COMPONENT_KINDS. */
	life_miles: [number, number] | null;
	life_months: [number, number] | null;
	condition: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

/** What one piece of gear has actually done, summed from its activities. */
export interface GearUse {
	activityCount: number;
	distanceM: number;
	movingSeconds: number;
	elevationGainM: number;
	/** local_date of the first/last activity tagged to it, or null if none. */
	firstDate: string | null;
	lastDate: string | null;
}

/** One activity, reduced to the numbers a gear total is made of. */
export interface GearRide {
	local_date: string;
	distance_m: number;
	moving_seconds: number;
	elevation_gain_m: number;
	/** Trainer/indoor. See isIndoorRide — decided once at read time so the
	 * per-component sums don't each re-derive it. */
	indoor: boolean;
}

/**
 * Whether an activity happened indoors, by the same rule the rest of the
 * section uses (activities.ts's route reader and its `indoor` filter): the
 * sport's own flag in sports.ts, or the explicit `sub_sport = 'indoor'` marker.
 * There is no first-class indoor column, so this is the one heuristic, defined
 * once.
 */
export function isIndoorRide(row: { sport?: string | null; sub_sport?: string | null }): boolean {
	if (row.sub_sport === 'indoor') return true;
	return !!row.sport && sportMeta(row.sport).indoor;
}

const EMPTY_USE: GearUse = {
	activityCount: 0,
	distanceM: 0,
	movingSeconds: 0,
	elevationGainM: 0,
	firstDate: null,
	lastDate: null,
};

/**
 * Sum a set of rides, optionally only those inside a date window. `from` and
 * `to` are inclusive 'YYYY-MM-DD' — string compare is correct for ISO dates
 * and keeps timezones out of a question that has no hour in it.
 */
export function sumRides(rides: GearRide[], from?: string | null, to?: string | null): GearUse {
	const use: GearUse = { ...EMPTY_USE };
	for (const r of rides) {
		if (from && r.local_date < from) continue;
		if (to && r.local_date > to) continue;
		use.activityCount++;
		use.distanceM += r.distance_m;
		use.movingSeconds += r.moving_seconds;
		use.elevationGainM += r.elevation_gain_m;
		if (use.firstDate == null || r.local_date < use.firstDate) use.firstDate = r.local_date;
		if (use.lastDate == null || r.local_date > use.lastDate) use.lastDate = r.local_date;
	}
	return use;
}

/** How worn a component is, on whichever axes its kind actually has. */
export interface ComponentWear {
	component: GearComponent;
	meta: ComponentMeta;
	/** Miles since fitted, including whatever it arrived with. */
	miles: number;
	/** Days since fitted (to removal, if it's been removed). */
	days: number;
	/** Rides it has been on. */
	rides: number;
	/**
	 * 0–1 against the far end of the replacement window, whichever axis is
	 * further along. Null for the condition-only parts (bearings, valves) — a
	 * bottom bracket has no mileage number that means anything, and inventing
	 * one so the bar has something to draw would be the page telling a story
	 * the data doesn't support.
	 */
	fraction: number | null;
	status: 'ok' | 'due' | 'overdue' | 'monitor' | 'retired';
	/** Indoor miles inside this part's window that were NOT counted against it
	 * (0 unless the kind is outdoorOnly). Surfaced so the page can say why a
	 * tire's odometer disagrees with the chain's on the same bike. */
	excludedIndoorMiles: number;
}

/**
 * This kind's defaults with the instance's own windows laid over them.
 *
 * An override REPLACES an axis rather than adding one, and clearing it falls
 * back to the default — so a 45mm gravel tire can say 4,000–8,000 miles
 * without teaching COMPONENT_KINDS a new part kind. An override on an axis the
 * kind doesn't otherwise have (months on a chain, say) is honoured too: the
 * axis simply exists for that instance, which is the point of an override.
 */
export function effectiveMeta(component: GearComponent): ComponentMeta {
	const base = COMPONENT_KINDS[component.kind] ?? COMPONENT_KINDS.other;
	if (!component.life_miles && !component.life_months) return base;
	return {
		...base,
		lifeMiles: component.life_miles ?? base.lifeMiles,
		lifeMonths: component.life_months ?? base.lifeMonths,
	};
}

/**
 * Wear for one component. `rides` is that gear's full ride list — the window is
 * applied here rather than at the query, so one read serves every part on the
 * bike.
 */
export function wearOf(component: GearComponent, rides: GearRide[], today = isoToday()): ComponentWear {
	const meta = effectiveMeta(component);
	const end = component.removed_on ?? today;
	// Brakes, wheels and tires don't wear on a trainer: the cranks turn but the
	// bike doesn't move, so those parts see the window's OUTDOOR rides only.
	// The drivetrain sees all of them — a chain wears exactly the same indoors.
	const eligible = meta.outdoorOnly ? rides.filter((r) => !r.indoor) : rides;
	const use = sumRides(eligible, component.installed_on, end);
	const miles = (use.distanceM + component.baseline_distance_m) / METERS_PER_MILE;
	const excludedIndoorMiles = meta.outdoorOnly
		? (sumRides(rides, component.installed_on, end).distanceM - use.distanceM) / METERS_PER_MILE
		: 0;
	const days = Math.max(0, daysBetween(component.installed_on, end));

	// Each axis reports a fraction of its own far end; the part is as worn as
	// its worst axis. Bar tape at 18 months is due whatever the odometer says.
	const axes: number[] = [];
	if (meta.lifeMiles) axes.push(miles / meta.lifeMiles[1]);
	if (meta.lifeMonths) axes.push(days / DAYS_PER_MONTH / meta.lifeMonths[1]);
	const fraction = axes.length ? Math.max(...axes) : null;

	let status: ComponentWear['status'];
	if (component.removed_on) status = 'retired';
	else if (fraction == null) status = 'monitor';
	else if (fraction >= 1) status = 'overdue';
	else if (dueStarted(meta, miles, days)) status = 'due';
	else status = 'ok';

	return { component, meta, miles, days, rides: use.activityCount, fraction, status, excludedIndoorMiles };
}

/** Past the near end of the window on any axis — "start thinking about it". */
function dueStarted(meta: ComponentMeta, miles: number, days: number): boolean {
	if (meta.lifeMiles && miles >= meta.lifeMiles[0]) return true;
	if (meta.lifeMonths && days / DAYS_PER_MONTH >= meta.lifeMonths[0]) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Dates and units — the gear pages' own. Distance and duration have a
// formatter in sports.ts; these are the readings it doesn't have.
// ---------------------------------------------------------------------------

/** Today, 'YYYY-MM-DD', in the reader's local reckoning rather than UTC's. */
export function isoToday(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Whole days from one ISO date to another. Both are plain dates, so this is
 * UTC arithmetic on purpose — no offset can apply to a day with no hour in it,
 * and doing it in local time would lose a day at every DST boundary. */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** activity_gear.retired_at is a timestamptz; every page says it as a date. */
export function retiredDate(gear: { retired_at: string | null }): string | null {
	return gear.retired_at ? gear.retired_at.slice(0, 10) : null;
}

/** "2,340 mi" — the odometer reading, the unit this site says distances in. */
export function milesText(meters: number): string {
	return `${Math.round(meters / METERS_PER_MILE).toLocaleString('en-US')} mi`;
}

/** Moving time as whole hours — a gear total is hundreds of them, so the
 * minutes formatStat would print are noise at this scale. */
export function hoursText(seconds: number): string {
	return `${Math.round(seconds / 3600).toLocaleString('en-US')} h`;
}

/** A component's age said the way a mechanic says it: days, then months, then
 * years, because "413 days" is not an answer anyone acts on. */
export function ageText(days: number): string {
	if (days < 60) return `${days} ${days === 1 ? 'day' : 'days'}`;
	const months = Math.round(days / DAYS_PER_MONTH);
	if (months < 24) return `${months} mo`;
	return `${(days / 365.25).toFixed(1)} yr`;
}

/** "2,000–4,000 mi", "3–6 months", or '' for the condition-only parts. */
export function intervalText(meta: ComponentMeta): string {
	if (meta.lifeMiles) return `${meta.lifeMiles[0].toLocaleString()}–${meta.lifeMiles[1].toLocaleString()} mi`;
	if (meta.lifeMonths) return `${meta.lifeMonths[0]}–${meta.lifeMonths[1]} months`;
	return '';
}

/** Whether a component is running on its own window rather than its kind's —
 * the page marks these, because a reader comparing two chains needs to know
 * one of them is being judged against a different ruler. */
export function hasOwnInterval(component: GearComponent): boolean {
	return !!component.life_miles || !!component.life_months;
}

/**
 * Parse a window the way it's written on the page: "2500-5000 mi",
 * "4–8 mo", "3-6 months". Returns which axis it names and the pair, or null if
 * it isn't one — an unparseable string must not silently become a window,
 * since a wrong window is worse than no override.
 */
export function parseInterval(
	input: string,
): { axis: 'miles' | 'months'; window: [number, number] } | null {
	const m = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*(mi|mile|miles|mo|month|months)\s*$/i.exec(input);
	if (!m) return null;
	const lo = Number(m[1]);
	const hi = Number(m[2]);
	// Same rule the DB check enforces: both ends positive and in order.
	if (!(lo > 0 && hi >= lo)) return null;
	return { axis: /^mi/i.test(m[3]) ? 'miles' : 'months', window: [lo, hi] };
}

export { METERS_PER_MILE };
