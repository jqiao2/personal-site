// The "All activities" filter state — read out of a query string, and the
// shared read path both /activities/all and /api/activities/list use to
// resolve it into rows. Same split as watched-params.ts/watched-filters.ts:
// the page and the API parse the SAME query string through the SAME module
// so the server-rendered first page and the batches paged in afterwards
// cannot drift. ACTIVITIES.md §8 is the filter/sort list this mirrors.
//
// UNITS ON THE WIRE. sports.ts's whole point is that this athlete's numbers
// read as miles/feet/minutes, the way his watch already shows them — so the
// query string speaks those units too (distmin=10 means "10 miles"), and this
// module does the one conversion into the metres/seconds `ActivityQuery`
// actually filters on. A hand-typed link stays in the athlete's own units
// instead of asking him to do metric math to edit one.
//
// WHY measuredOnly ISN'T ON ActivityQuery. `activities.ts` (the schema
// track's file, already committed) has no exertion_confidence column filter —
// ACTIVITIES.md §3 asks the UI to let the reader filter to measured-only, but
// that's a List-track requirement landing after the query layer shipped, and
// this track doesn't own activities.ts. `ActivityFilterQuery` is
// `ActivityQuery` plus that one extra field, and `fetchActivityPage` below is
// the one place that knows how to honour it — by pulling the (small, few-
// hundred-row) filtered collection once and paging/filtering in JS rather
// than teaching every caller a second, DB-less filter step.
import { siteYear } from './day';
import { exertionLabel } from './activity-tokens';
import { sportMeta } from './sports';
import { supabasePublic } from './supabase';
import { visitorQuery } from './activity-privacy';
import {
	isActivitySort,
	listActivities,
	listActivityFacets,
	listGear,
	type ActivityListRow,
	type ActivityQuery,
} from './activities';

export interface ActivityFilterQuery extends ActivityQuery {
	/** Restrict to exertion_confidence = 'measured' — see the header comment
	 * for why this lives here rather than on ActivityQuery. */
	measuredOnly?: boolean;
}

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Earliest local_date worth asking for — before this is a fat-fingered year. */
const DATE_FLOOR = '1990-01-01';

/**
 * The "All activities" filter state, read out of a query string. Anything
 * unrecognized falls back to "don't filter by this" rather than erroring —
 * these params are hand-editable and arrive from old links.
 */
export function activityQueryFromParams(p: URLSearchParams): ActivityFilterQuery {
	const sort = p.get('sort');
	const dir = p.get('dir');
	return {
		sort: isActivitySort(sort) ? sort : 'date',
		sortDir: dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : undefined,
		sports: p.getAll('sport').filter((s) => s.trim() !== ''),
		dateFrom: dateBound(p.get('datefrom')),
		dateTo: dateBound(p.get('dateto')),
		distanceMinM: milesBound(p.get('distmin')),
		distanceMaxM: milesBound(p.get('distmax')),
		durationMinS: minutesBound(p.get('durmin')),
		durationMaxS: minutesBound(p.get('durmax')),
		elevationMinM: feetBound(p.get('elevmin')),
		elevationMaxM: feetBound(p.get('elevmax')),
		exertionMin: exertionBound(p.get('exmin')),
		exertionMax: exertionBound(p.get('exmax')),
		hasGps: boolFlag(p.get('gps')),
		gearIds: p
			.getAll('gear')
			.map((v) => Number.parseInt(v, 10))
			.filter((n) => Number.isFinite(n) && n > 0),
		indoor: boolFlag(p.get('indoor')),
		hasPower: p.get('power') === '1',
		hasHr: p.get('hr') === '1',
		place: p.get('place')?.trim() || undefined,
		personalBestOnly: p.get('pr') === '1',
		measuredOnly: p.get('measured') === '1',
	};
}

/** How many filters are on — the number the "Filters" button badges. Each
 * range counts once however many steps it spans; each multi-select item
 * (a sport, a piece of gear) counts on its own, mirroring watchedFilterCount. */
export function activityFilterCount(q: ActivityFilterQuery): number {
	return (
		(q.sports?.length ?? 0) +
		(q.dateFrom != null || q.dateTo != null ? 1 : 0) +
		(q.distanceMinM != null || q.distanceMaxM != null ? 1 : 0) +
		(q.durationMinS != null || q.durationMaxS != null ? 1 : 0) +
		(q.elevationMinM != null || q.elevationMaxM != null ? 1 : 0) +
		(q.exertionMin != null || q.exertionMax != null ? 1 : 0) +
		(q.hasGps != null ? 1 : 0) +
		(q.gearIds?.length ?? 0) +
		(q.indoor != null ? 1 : 0) +
		(q.hasPower ? 1 : 0) +
		(q.hasHr ? 1 : 0) +
		(q.place ? 1 : 0) +
		(q.personalBestOnly ? 1 : 0) +
		(q.measuredOnly ? 1 : 0)
	);
}

/** Whether the query narrows the collection at all — there's no free-text
 * search box on this page (§8 names no such filter), so unlike
 * isWatchedFiltered this is exactly "any filter is on". */
export function isActivityFiltered(q: ActivityFilterQuery): boolean {
	return activityFilterCount(q) > 0;
}

function nonNegative(raw: string | null): number | null {
	if (raw == null) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A "YYYY-MM-DD" bound, or undefined if absent/malformed/absurd. */
function dateBound(raw: string | null): string | undefined {
	if (raw == null || !DATE_RE.test(raw)) return undefined;
	const ceiling = `${siteYear() + 1}-12-31`;
	if (raw < DATE_FLOOR || raw > ceiling) return undefined;
	return raw;
}

function milesBound(raw: string | null): number | undefined {
	const n = nonNegative(raw);
	return n == null ? undefined : n * METERS_PER_MILE;
}

function minutesBound(raw: string | null): number | undefined {
	const n = nonNegative(raw);
	return n == null ? undefined : n * 60;
}

function feetBound(raw: string | null): number | undefined {
	const n = nonNegative(raw);
	return n == null ? undefined : n * METERS_PER_FOOT;
}

/** Exertion has no natural ceiling (§3: "~0-500", and a multi-day effort could
 * exceed that), so this only floors at zero and drops non-finite input. */
function exertionBound(raw: string | null): number | undefined {
	return nonNegative(raw) ?? undefined;
}

function boolFlag(raw: string | null): boolean | undefined {
	if (raw === '1') return true;
	if (raw === '0') return false;
	return undefined;
}

// ---------------------------------------------------------------------------
// fetchActivityPage — the read path /activities/all and the list API share.
// ---------------------------------------------------------------------------

const MEASURED_FETCH_CAP = 5000; // headroom over the whole collection today (~190)

/**
 * One page of the filtered, sorted collection. Delegates straight to
 * `listActivities` for every filter it supports; `measuredOnly` has no column
 * filter there (see the header comment), so that one case pulls the whole
 * matching set once and paginates in JS instead of at the database.
 */
export async function fetchActivityPage(
	query: ActivityFilterQuery,
	page: { limit: number; offset: number },
	isOwner = false,
): Promise<{ rows: ActivityListRow[]; total: number }> {
	const { measuredOnly, ...rest } = isOwner ? query : visitorQuery(query);
	if (!measuredOnly) {
		return listActivities({ ...rest, limit: page.limit, offset: page.offset }, isOwner);
	}
	const { rows: all } = await listActivities({ ...rest, limit: MEASURED_FETCH_CAP, offset: 0 }, isOwner);
	const measured = all.filter((r) => r.exertion_confidence === 'measured');
	return {
		rows: measured.slice(page.offset, page.offset + page.limit),
		total: measured.length,
	};
}

// ---------------------------------------------------------------------------
// fetchActivityFacets — what the filter panel needs to draw itself: sport and
// gear/place counts, plus the min/max of each range so the sliders can size
// themselves. Shared by /activities/all's server render and
// /api/activities/facets, the same way fetchActivityPage is.
// ---------------------------------------------------------------------------

export interface ActivityBounds {
	min: number;
	max: number;
}

export const EMPTY_FACETS: ActivityFacetsPayload = {
	sports: [],
	gear: [],
	places: [],
	distanceM: null,
	durationS: null,
	elevationM: null,
	exertion: null,
};

export interface ActivityFacetsPayload {
	sports: { sport: string; count: number }[];
	gear: { id: number; name: string; kind: string }[];
	places: { place: string; count: number }[];
	distanceM: ActivityBounds | null;
	durationS: ActivityBounds | null;
	elevationM: ActivityBounds | null;
	exertion: ActivityBounds | null;
}

/** The min and max of one numeric column across top-level activities, via two
 * cheap one-row queries rather than paging the whole table — unlike
 * listActivityFacets, which has to fold three group-bys PostgREST can't do
 * server-side, a min/max is exactly what `order().limit(1)` gives for free. */
async function columnBounds(column: string): Promise<ActivityBounds | null> {
	try {
		const [{ data: lo }, { data: hi }] = await Promise.all([
			supabasePublic
				.from('activity_list')
				.select(column)
				.is('parent_id', null)
				.not(column, 'is', null)
				.order(column, { ascending: true })
				.limit(1),
			supabasePublic
				.from('activity_list')
				.select(column)
				.is('parent_id', null)
				.not(column, 'is', null)
				.order(column, { ascending: false })
				.limit(1),
		]);
		const min = (lo?.[0] as Record<string, number> | undefined)?.[column];
		const max = (hi?.[0] as Record<string, number> | undefined)?.[column];
		if (min == null || max == null) return null;
		return { min, max };
	} catch {
		// Table/column not applied yet in this environment — an empty facets
		// payload degrades to "no sliders drawn", same as a fresh, unseeded log.
		return null;
	}
}

export async function fetchActivityFacets(isOwner = false): Promise<ActivityFacetsPayload> {
	// Every bound below is a private activity's number said out loud — the
	// longest ride, the biggest day of climbing. A visitor gets the empty
	// payload, which draws as a panel with no chips and no sliders.
	if (!isOwner) return EMPTY_FACETS;
	const [facets, gear, distanceM, durationS, elevationM, exertion] = await Promise.all([
		listActivityFacets(isOwner),
		listGear(),
		columnBounds('distance_m'),
		columnBounds('moving_seconds'),
		columnBounds('elevation_gain_m'),
		columnBounds('exertion'),
	]);
	return {
		sports: facets.sports,
		gear: gear.map((g) => ({ id: g.id, name: g.nickname || g.name, kind: g.kind })),
		places: facets.places,
		distanceM,
		durationS,
		elevationM,
		exertion,
	};
}

// ---------------------------------------------------------------------------
// The filter summary sentence — same job as watched-filters.ts's
// filterSentence, split into {t, em} parts so the caller can highlight values.
// ---------------------------------------------------------------------------

export interface ActivityFilterSummary {
	/** Activities matching — the number the sentence opens on. */
	total: number;
	sports: string[];
	dateFrom: string | null;
	dateTo: string | null;
	distanceMinM: number | null;
	distanceMaxM: number | null;
	durationMinS: number | null;
	durationMaxS: number | null;
	elevationMinM: number | null;
	elevationMaxM: number | null;
	exertionMin: number | null;
	exertionMax: number | null;
	hasGps: boolean | null;
	indoor: boolean | null;
	hasPower: boolean;
	hasHr: boolean;
	place: string | null;
	personalBestOnly: boolean;
	measuredOnly: boolean;
	gearNames: string[];
}

export interface SentencePart {
	t: string;
	em: boolean;
}

/** Join names as "a", "a and b", "a, b, and c". */
function andList(items: string[], conj = 'and'): string {
	if (items.length <= 1) return items.join('');
	if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

/** The one-sport verb the sentence opens with ("ridden 42 activities"); a
 * mixed or unfiltered sport selection falls back to the generic "logged". */
const SPORT_VERB: Record<string, string> = {
	ride: 'ridden',
	gravel_ride: 'ridden',
	mountain_bike: 'ridden',
	virtual_ride: 'ridden',
	run: 'run',
	treadmill_run: 'run',
	trail_run: 'run',
	swim: 'swum',
	open_water_swim: 'swum',
	hike: 'hiked',
	walk: 'walked',
	snowshoe: 'snowshoed',
	alpine_ski: 'skied',
	backcountry_ski: 'skied',
	nordic_ski: 'skied',
	snowboard: 'ridden',
	strength: 'lifted through',
	yoga: 'practiced',
	rowing: 'rowed',
	transition: 'logged',
	other: 'logged',
};

function miTxt(m: number): string {
	const mi = m / METERS_PER_MILE;
	return `${mi % 1 === 0 ? mi.toFixed(0) : mi.toFixed(1)} mi`;
}
function ftTxt(m: number): string {
	return `${Math.round(m / METERS_PER_FOOT).toLocaleString('en-US')} ft`;
}
function durTxt(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A plain-English summary of every active filter, e.g. "You have ridden 42
 * activities over 100 miles at hard or above." Split into parts rather than
 * a string so each value can be highlighted; the caller wraps them in
 * whatever element it draws with, the same contract as filterSentence.
 */
export function activityFilterSentence(s: ActivityFilterSummary): SentencePart[] {
	const parts: SentencePart[] = [];
	const lit = (t: string) => parts.push({ t, em: false });
	const em = (t: string) => parts.push({ t, em: true });

	const verb = s.sports.length === 1 ? (SPORT_VERB[s.sports[0]] ?? 'logged') : 'logged';
	lit(`You have ${verb} `);
	em(s.total.toLocaleString('en-US'));
	lit(s.total === 1 ? ' activity' : ' activities');

	if (s.sports.length > 1) {
		lit(' across ');
		em(andList(s.sports.map((slug) => sportMeta(slug).label)));
	} else if (s.sports.length === 1 && verb === 'logged') {
		// The verb already names the sport for the families with their own word
		// (ridden, run, swum…); the generic fallback still has to name it.
		lit(' of ');
		em(sportMeta(s.sports[0]).label);
	}

	if (s.personalBestOnly) {
		lit(' that are ');
		em('personal bests');
	}

	if (s.dateFrom || s.dateTo) {
		if (s.dateFrom && s.dateTo) {
			lit(' between ');
			em(`${s.dateFrom} and ${s.dateTo}`);
		} else if (s.dateFrom) {
			lit(' since ');
			em(s.dateFrom);
		} else {
			lit(' before ');
			em(s.dateTo!);
		}
	}

	if (s.distanceMinM != null || s.distanceMaxM != null) {
		if (s.distanceMinM != null && s.distanceMaxM != null) {
			lit(' between ');
			em(`${miTxt(s.distanceMinM)} and ${miTxt(s.distanceMaxM)}`);
		} else if (s.distanceMinM != null) {
			lit(' over ');
			em(miTxt(s.distanceMinM));
		} else {
			lit(' under ');
			em(miTxt(s.distanceMaxM!));
		}
	}

	if (s.durationMinS != null || s.durationMaxS != null) {
		if (s.durationMinS != null && s.durationMaxS != null) {
			lit(' lasting between ');
			em(`${durTxt(s.durationMinS)} and ${durTxt(s.durationMaxS)}`);
		} else if (s.durationMinS != null) {
			lit(' lasting over ');
			em(durTxt(s.durationMinS));
		} else {
			lit(' lasting under ');
			em(durTxt(s.durationMaxS!));
		}
	}

	if (s.elevationMinM != null || s.elevationMaxM != null) {
		if (s.elevationMinM != null && s.elevationMaxM != null) {
			lit(' climbing between ');
			em(`${ftTxt(s.elevationMinM)} and ${ftTxt(s.elevationMaxM)}`);
		} else if (s.elevationMinM != null) {
			lit(' climbing over ');
			em(ftTxt(s.elevationMinM));
		} else {
			lit(' climbing under ');
			em(ftTxt(s.elevationMaxM!));
		}
	}

	// §3's scale, spoken the way the slider itself is labelled — never a bare
	// number, so the sentence never implies the raw score means the same thing
	// across a power-derived and a MET-derived value on its own.
	if (s.exertionMin != null || s.exertionMax != null) {
		if (s.exertionMin != null && s.exertionMax != null) {
			lit(' at ');
			em(`${exertionLabel(s.exertionMin)} to ${exertionLabel(s.exertionMax)}`);
			lit(' effort');
		} else if (s.exertionMin != null) {
			lit(' at ');
			em(`${exertionLabel(s.exertionMin)} or above`);
		} else {
			lit(' at ');
			em(`${exertionLabel(s.exertionMax!)} or below`);
		}
	}

	if (s.hasGps === true) {
		lit(' with a ');
		em('GPS route');
	} else if (s.hasGps === false) {
		lit(' with ');
		em('no GPS');
	}

	if (s.indoor === true) {
		lit(' ');
		em('indoors');
	} else if (s.indoor === false) {
		lit(' ');
		em('outdoors');
	}

	if (s.hasPower) {
		lit(' with ');
		em('power data');
	}
	if (s.hasHr) {
		lit(' with ');
		em('heart-rate data');
	}
	if (s.measuredOnly) {
		lit(' with ');
		em('measured');
		lit(' exertion only');
	}

	if (s.gearNames.length) {
		lit(' using ');
		em(andList(s.gearNames));
	}
	if (s.place) {
		lit(' starting near ');
		em(`"${s.place}"`);
	}

	lit('.');
	return parts;
}
