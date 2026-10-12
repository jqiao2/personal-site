// Links between activities and meals (migration 0068): the ride to the pizza
// place, the run that ended at brunch.
//
// Each side lists its links and the same-day candidates the owner can tick.
//
// PRIVACY. Meals are public; activities may not be. A private activity is
// dropped from a meal's list for a visitor rather than shown redacted, the same
// rule pins.ts applies. Reads go through supabaseAdmin so the owner sees all.
import { supabaseAdmin } from './supabase';
import { formatStat, sportMeta } from './sports';

export interface LinkedActivity {
	id: number;
	title: string;
	sport: string;
	sportLabel: string;
	local_date: string;
	/** "12.4 mi", or null when the activity has no distance. */
	distance: string | null;
	private: boolean;
}

export interface LinkedMeal {
	id: number;
	restaurant_name: string;
	visited_on: string;
}

async function linkedIds(column: 'activity_id' | 'visit_id', id: number): Promise<number[]> {
	const other = column === 'activity_id' ? 'visit_id' : 'activity_id';
	const { data, error } = await supabaseAdmin.from('activity_meals').select(other).eq(column, id);

	// The links are a footnote on both pages, so a failed read (a database behind
	// on 0068) shows none rather than taking the page down.
	if (error) return [];

	// SAFETY: the select above names exactly one bigint column, `other`.
	return ((data ?? []) as Record<string, number>[]).map((r) => Number(r[other]));
}

type ActivityPick = { id: number; title: string; sport: string; local_date: string; distance_m: number | null; private: boolean };

function toLinkedActivity(a: ActivityPick): LinkedActivity {
	const distance = formatStat('distance', a).value;

	return {
		id: a.id,
		title: a.title,
		sport: a.sport,
		sportLabel: sportMeta(a.sport).label,
		local_date: a.local_date,
		distance: distance === '—' ? null : distance,
		// Only an explicit false is public, as in activity-privacy.ts.
		private: a.private !== false,
	};
}

/** Activities by id, or in a date window, oldest first. Owner sees all; a
 *  visitor gets public ones only. */
async function selectActivities(filter: { ids: number[] } | { from: string; to: string }, isOwner: boolean): Promise<LinkedActivity[]> {
	let q = supabaseAdmin
		.from('activities')
		.select('id, title, sport, local_date, distance_m, private')
		.is('deleted_at', null)
		.is('parent_id', null)
		.order('started_at');

	if ('ids' in filter) {
		if (filter.ids.length === 0) return [];
		q = q.in('id', filter.ids);
	} else {
		q = q.gte('local_date', filter.from).lte('local_date', filter.to);
	}

	const { data, error } = await q;

	if (error) throw new Error(`activity_meals activities failed: ${error.message}`);

	// SAFETY: the select above names exactly ActivityPick's columns.
	return ((data ?? []) as ActivityPick[]).map(toLinkedActivity).filter((a) => isOwner || !a.private);
}

async function selectMeals(filter: { ids: number[] } | { from: string; to: string }): Promise<LinkedMeal[]> {
	let q = supabaseAdmin.from('restaurant_diary').select('id, restaurant_name, visited_on').order('visited_on').order('id');

	if ('ids' in filter) {
		if (filter.ids.length === 0) return [];
		q = q.in('id', filter.ids);
	} else {
		q = q.gte('visited_on', filter.from).lte('visited_on', filter.to);
	}

	const { data, error } = await q;

	if (error) throw new Error(`activity_meals meals failed: ${error.message}`);

	// SAFETY: the select above names exactly LinkedMeal's columns.
	return (data ?? []) as LinkedMeal[];
}

/** The activities linked to a meal. Private ones are dropped unless isOwner. */
export async function activitiesForMeal(visitId: number, isOwner = false): Promise<LinkedActivity[]> {
	return selectActivities({ ids: await linkedIds('visit_id', visitId) }, isOwner);
}

/** The meals linked to an activity. Meals are public, so no owner switch. */
export async function mealsForActivity(activityId: number): Promise<LinkedMeal[]> {
	return selectMeals({ ids: await linkedIds('activity_id', activityId) });
}

/** Owner-only: activities on the same day as a meal. */
export function activitiesNear(day: string): Promise<LinkedActivity[]> {
	return selectActivities({ from: day, to: day }, true);
}

/** Owner-only: meals on the same day as an activity. */
export function mealsNear(day: string): Promise<LinkedMeal[]> {
	return selectMeals({ from: day, to: day });
}

/**
 * Make `ids` exactly the set linked to one row: links not in it are removed,
 * new ones added. `column` names the side `id` is on.
 */
export async function setLinks(column: 'activity_id' | 'visit_id', id: number, ids: number[]): Promise<void> {
	const other = column === 'activity_id' ? 'visit_id' : 'activity_id';
	const keep = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];

	let del = supabaseAdmin.from('activity_meals').delete().eq(column, id);

	if (keep.length > 0) del = del.not(other, 'in', `(${keep.join(',')})`);

	const { error: delError } = await del;

	if (delError) throw new Error(`activity_meals unlink failed: ${delError.message}`);

	if (keep.length === 0) return;

	const { error } = await supabaseAdmin
		.from('activity_meals')
		.upsert(keep.map((n) => ({ [column]: id, [other]: n })), { onConflict: 'activity_id,visit_id', ignoreDuplicates: true });

	if (error) throw new Error(`activity_meals link failed: ${error.message}`);
}

/** "Oct 10" — tells an already-linked entry from another day apart. */
export function shortDay(day: string): string {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Candidates first linked, then the rest, deduped by id — so a link whose
 *  date has since moved out of the window still shows up to be unticked. */
export function withLinked<T extends { id: number }>(linked: T[], near: T[]): T[] {
	const ids = new Set(linked.map((r) => r.id));

	return [...linked, ...near.filter((r) => !ids.has(r.id))];
}
