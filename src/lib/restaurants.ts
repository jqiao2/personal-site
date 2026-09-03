// Service layer for the restaurant log, between the pages/API routes and
// Supabase. Reads go through the anon client (the tables are publicly readable,
// like the film log's); writes go through the service-role client and are only
// ever called after requireOwner().
import { supabaseAdmin, supabasePublic } from './supabase';
import { putPhoto, deletePhotoObject, r2PublicUrl } from './r2';
import { siteDay, siteYear } from './day';
import { monthLabel } from './share-card';

/** The four price bands, in order. Four steps, no half steps. */
export const PRICE_BANDS = ['$', '$$', '$$$', '$$$$'] as const;
export type PriceBand = (typeof PRICE_BANDS)[number];

export function isPriceBand(v: unknown): v is PriceBand {
	return typeof v === 'string' && (PRICE_BANDS as readonly string[]).includes(v);
}

/**
 * The kind of why, for a place on the to-try list.
 *
 * FIXED, AND SHORT ON PURPOSE. `to_try_reason` is the record — one line of
 * prose, and better prose than any taxonomy — but prose cannot be filtered,
 * and at eighty-odd places "the ones someone recommended" and "the ones I
 * walked past" are different lists. A free tag field would answer that with
 * synonyms: recommendation, rec, recommended, someone said. Eight words that
 * cover the reasons a place gets written down keep the filter meaning
 * something.
 */
export const WHY_TAGS = [
	'a dish',
	'a recommendation',
	'the room',
	'a group',
	'walked past',
	'press',
	'cheap eats',
	'late night',
] as const;
export type WhyTag = (typeof WHY_TAGS)[number];

export function isWhyTag(v: unknown): v is WhyTag {
	return typeof v === 'string' && (WHY_TAGS as readonly string[]).includes(v);
}

/**
 * "Would I go out of my way for it", as a filter.
 *
 * Three states rather than a checkbox: the interesting question on a long list
 * is as often "what's near me" as "what's worth the journey", and a checkbox
 * can only ask one of them.
 */
export type TripFilter = 'trip' | 'nearby';

export function isTripFilter(v: unknown): v is TripFilter {
	return v === 'trip' || v === 'nearby';
}

/**
 * Whether a place has a point, as a filter.
 *
 * NOT A PROPERTY OF THE RESTAURANT — a property of the record, which is why it
 * reads "on the map" rather than anything about the place itself. It exists
 * because ninety of the to-try entries arrived from a saved list with a name
 * and nothing else, and the only way to work through them is to be able to ask
 * for exactly those.
 */
export type MapFilter = 'on' | 'off';

export function isMapFilter(v: unknown): v is MapFilter {
	return v === 'on' || v === 'off';
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A row of the `restaurant_places` view: the place with its history folded in. */
export interface Place {
	id: number;
	name: string;
	cuisines: string[];
	price_band: PriceBand | null;
	neighborhood: string | null;
	city: string;
	state_region: string | null;
	country: string;
	lat: number | null;
	lng: number | null;
	google_place_id: string | null;
	website_url: string | null;
	yelp_url: string | null;
	beli_url: string | null;
	to_try_added_at: string | null;
	to_try_reason: string | null;
	visit_count: number;
	first_visit: string | null;
	last_visit: string | null;
	avg_rating: number | null;
	rated_count: number;
	hearted: boolean;
	latest_verdict: number | null;
	latest_verdict_on: string | null;
	cover_path: string | null;
	cover_width: number | null;
	cover_height: number | null;
	photo_count: number;
	on_to_try: boolean;
	created_at: string;
	/** Would I go out of my way for it — the place's own answer, not a visit's. */
	trip: boolean;
	/** The kind of why, from WHY_TAGS. Beside to_try_reason, never instead of it. */
	to_try_tags: string[];
}

/** A row of the `restaurant_diary` view: one visit, with its place inlined. */
export interface DiaryVisit {
	id: number;
	restaurant_id: number;
	visited_on: string;
	rating: number | null;
	verdict: number | null;
	hearted: boolean;
	revisit: boolean;
	friends: string[];
	review: string | null;
	/** Owner-only note, or null. Null for a visitor and when there is none —
	 *  getVisit only fetches it off the base table when includePrivate. */
	private_note: string | null;
	tags: string[];
	restaurant_name: string;
	cuisines: string[];
	neighborhood: string | null;
	city: string;
	state_region: string | null;
	country: string;
	photo_count: number;
	created_at: string;
}

export interface Photo {
	id: number;
	visit_id: number;
	storage_path: string;
	caption: string | null;
	width: number | null;
	height: number | null;
	position: number;
	/** Derived, not stored — the public URL for `storage_path`. */
	url: string;
}

/** A visit with its photographs attached. */
export interface VisitDetail extends DiaryVisit {
	photos: Photo[];
}

const PLACE_COLUMNS = '*';

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/**
 * Public URL for a stored photo. The bucket is public, so this is pure string
 * assembly — no round trip, and safe to call once per photo in a render loop.
 */
export function photoUrl(storagePath: string): string {
	return r2PublicUrl(storagePath);
}

function withUrl(row: Omit<Photo, 'url'>): Photo {
	return { ...row, url: photoUrl(row.storage_path) };
}

async function photosForVisits(visitIds: number[]): Promise<Map<number, Photo[]>> {
	const byVisit = new Map<number, Photo[]>();
	if (visitIds.length === 0) return byVisit;
	const { data, error } = await supabasePublic
		.from('restaurant_photos')
		.select('*')
		.in('visit_id', visitIds)
		.order('position')
		.order('id');
	if (error) throw new Error(error.message);
	for (const row of (data ?? []) as Omit<Photo, 'url'>[]) {
		const list = byVisit.get(row.visit_id) ?? [];
		list.push(withUrl(row));
		byVisit.set(row.visit_id, list);
	}
	return byVisit;
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

export interface RestaurantStats {
	/** Places eaten at at least once. The to-try list is not counted here. */
	places: number;
	visits: number;
	toTry: number;
	thisYear: number;
	/** Most-visited place, for the sidebar's "today's special" card. */
	mostVisited: { id: number; name: string; visits: number } | null;
	/** Latest month with any visit in it, as "YYYY-MM". */
	latestMonth: string | null;
}

export async function getRestaurantStats(): Promise<RestaurantStats> {
	const year = siteYear();
	const [places, visits, toTry] = await Promise.all([
		supabasePublic.from('restaurant_places').select('id,name,visit_count').gt('visit_count', 0),
		supabasePublic
			.from('restaurant_diary')
			.select('restaurant_id,visited_on')
			.order('visited_on', { ascending: false }),
		supabasePublic.from('restaurant_places').select('id', { count: 'exact', head: true }).eq('on_to_try', true),
	]);
	if (places.error) throw new Error(places.error.message);
	if (visits.error) throw new Error(visits.error.message);

	const placeRows = (places.data ?? []) as { id: number; name: string; visit_count: number }[];
	const visitRows = (visits.data ?? []) as { restaurant_id: number; visited_on: string }[];
	const top = placeRows.reduce<(typeof placeRows)[number] | null>(
		(best, r) => (best == null || r.visit_count > best.visit_count ? r : best),
		null,
	);

	return {
		places: placeRows.length,
		visits: visitRows.length,
		toTry: toTry.count ?? 0,
		// Restaurants this year, not meals — the sidebar line counts places, so
		// eating at the same counter eleven times is one of them.
		thisYear: new Set(
			visitRows.filter((v) => v.visited_on.startsWith(`${year}-`)).map((v) => v.restaurant_id),
		).size,
		mostVisited: top ? { id: top.id, name: top.name, visits: top.visit_count } : null,
		latestMonth: visitRows[0]?.visited_on.slice(0, 7) ?? null,
	};
}

/** The hand-picked top four, in rank order. Fewer than four is normal. */
/** The most recent visits, newest first, with their photographs attached. */
export async function listRecentVisits(limit = 4): Promise<VisitDetail[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('*')
		.order('visited_on', { ascending: false })
		.order('id', { ascending: false })
		.limit(limit);
	if (error) throw new Error(error.message);
	const visits = (data ?? []) as DiaryVisit[];
	const photos = await photosForVisits(visits.map((v) => v.id));
	return visits.map((v) => ({ ...v, photos: photos.get(v.id) ?? [] }));
}

/** The to-try list, most recently added first. */
export async function listToTry(limit?: number): Promise<Place[]> {
	let q = supabasePublic
		.from('restaurant_places')
		.select(PLACE_COLUMNS)
		.eq('on_to_try', true)
		.order('to_try_added_at', { ascending: false });
	if (limit != null) q = q.limit(limit);
	const { data, error } = await q;
	if (error) throw new Error(error.message);
	return (data ?? []) as Place[];
}

// ---------------------------------------------------------------------------
// The list view
// ---------------------------------------------------------------------------

/**
 * Which half of the log is being listed.
 *
 * They are the same rows in the same table — a place you mean to go to is a
 * restaurant with no visits yet — so every list and facet here takes the scope
 * rather than existing twice. The two halves want different sorts and, on the
 * to-try side, a couple of the filters have nothing to bite on: a place you
 * haven't been to has no rating and no verdict.
 */
export type PlaceScope = 'visited' | 'to-try';

export type PlaceSort = 'recent' | 'rating' | 'verdict' | 'name' | 'added' | 'price' | 'trip';

export function isPlaceSort(v: unknown): v is PlaceSort {
	return (
		v === 'recent' ||
		v === 'rating' ||
		v === 'verdict' ||
		v === 'name' ||
		v === 'added' ||
		v === 'price' ||
		v === 'trip'
	);
}

export interface PlaceQuery {
	scope?: PlaceScope;
	cuisines?: string[];
	prices?: PriceBand[];
	/** "This rung or better", as a rank. 5 (Avoid) means no threshold at all. */
	verdictAtLeast?: number | null;
	/** Worth the trip, or only if I'm nearby. Absent means both. */
	trip?: TripFilter | null;
	/** Any of these why-tags. Absent means all. */
	tags?: string[];
	/** On the map, or not on it. Absent means both. */
	onMap?: MapFilter | null;
	sort?: PlaceSort;
}

/**
 * Every place I've eaten at, filtered. Fetched whole and filtered in memory:
 * this is a personal log in the low hundreds of rows, and doing it here keeps
 * the multi-valued cuisine match and the "or better" verdict threshold in one
 * readable place instead of split across PostgREST operators.
 */
export async function listPlaces(query: PlaceQuery = {}): Promise<Place[]> {
	const scope = query.scope ?? 'visited';
	const { data, error } = await inScope(
		supabasePublic.from('restaurant_places').select(PLACE_COLUMNS),
		scope,
	);
	if (error) throw new Error(error.message);
	let rows = (data ?? []) as Place[];

	if (query.cuisines?.length) {
		const want = new Set(query.cuisines.map((c) => c.toLowerCase()));
		rows = rows.filter((r) => cuisineTerms(r.cuisines).some((c) => want.has(c.toLowerCase())));
	}
	if (query.prices?.length) {
		const want = new Set<string>(query.prices);
		rows = rows.filter((r) => r.price_band != null && want.has(r.price_band));
	}
	if (query.verdictAtLeast != null && query.verdictAtLeast < 5) {
		const max = query.verdictAtLeast;
		rows = rows.filter((r) => r.latest_verdict != null && r.latest_verdict <= max);
	}
	if (query.trip) rows = rows.filter((r) => (query.trip === 'trip' ? r.trip : !r.trip));
	if (query.onMap) {
		const placed = (r: Place) => r.lat != null && r.lng != null;
		rows = rows.filter((r) => (query.onMap === 'on' ? placed(r) : !placed(r)));
	}
	if (query.tags?.length) {
		const want = new Set(query.tags);
		rows = rows.filter((r) => r.to_try_tags.some((t) => want.has(t)));
	}

	return sortPlaces(rows, query.sort ?? (scope === 'to-try' ? 'added' : 'recent'));
}

/**
 * The two halves of the table, as a filter on a query builder.
 *
 * `on_to_try` is computed by the view — marked, and not yet been — so a place
 * leaves the to-try list by being visited rather than by anything remembering
 * to take it off.
 */
function inScope<T>(query: T, scope: PlaceScope): T {
	const q = query as { eq: (c: string, v: unknown) => T; gt: (c: string, v: unknown) => T };
	return scope === 'to-try' ? q.eq('on_to_try', true) : q.gt('visit_count', 0);
}

function sortPlaces(rows: Place[], sort: PlaceSort): Place[] {
	const byName = (a: Place, b: Place) => a.name.localeCompare(b.name, 'en');
	const copy = [...rows];
	switch (sort) {
		case 'added':
			return copy.sort(
				(a, b) => (b.to_try_added_at ?? '').localeCompare(a.to_try_added_at ?? '') || byName(a, b),
			);
		case 'trip':
			// Worth the trip first, and within each half the order the list
			// already had, so marking one place does not reshuffle the rest.
			return copy.sort(
				(a, b) =>
					Number(b.trip) - Number(a.trip) ||
					(b.to_try_added_at ?? '').localeCompare(a.to_try_added_at ?? '') ||
					byName(a, b),
			);
		case 'price':
			// Cheapest first, and a place with no price band sorts last rather
			// than as free — the same reading an absent rating gets below.
			return copy.sort(
				(a, b) =>
					(a.price_band?.length ?? 99) - (b.price_band?.length ?? 99) || byName(a, b),
			);
		case 'rating':
			// Unrated places sort last rather than as zero — an absent rating is
			// not a bad one.
			return copy.sort(
				(a, b) => (b.avg_rating ?? -1) - (a.avg_rating ?? -1) || byName(a, b),
			);
		case 'verdict':
			return copy.sort(
				(a, b) => (a.latest_verdict ?? 99) - (b.latest_verdict ?? 99) || byName(a, b),
			);
		case 'name':
			return copy.sort(byName);
		case 'recent':
		default:
			return copy.sort((a, b) => (b.last_visit ?? '').localeCompare(a.last_visit ?? '') || byName(a, b));
	}
}

export interface CuisineFacet {
	name: string;
	count: number;
}

/**
 * Cuisines with their counts, commonest first.
 *
 * Cuisine is multi-valued and long-tailed — a hundred places carry sixty
 * distinct values, most of them once. The filter bar shows the head and hides
 * the tail behind a disclosure rather than printing sixty chips; this returns
 * the whole ordered list and lets the caller decide where to cut.
 */
export async function listCuisineFacets(scope: PlaceScope = 'visited'): Promise<CuisineFacet[]> {
	const { data, error } = await inScope(
		supabasePublic.from('restaurant_places').select('cuisines'),
		scope,
	);
	if (error) throw new Error(error.message);
	const counts = new Map<string, number>();
	for (const row of (data ?? []) as { cuisines: string[] }[]) {
		// De-duplicated per place: a row storing "Pizza" and "Pizza, Pasta" must
		// not count Pizza twice.
		for (const c of new Set(cuisineTerms(row.cuisines))) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));
}

/**
 * The cuisines on a place, one per value.
 *
 * The column is an array and the composer's cuisine field is one line of text,
 * which it stored WHOLE: rows exist reading `["Vietnamese, Sandwich"]` and
 * `["American, Burger, Soup, Salad, Omelette, Sandwich, Breakfast"]`. Splitting
 * on read keeps those rows filterable — and their chips legible — without a
 * migration, and costs nothing on a row that was stored properly. The composer
 * splits on save now too, so this is for what is already in the table.
 */
export function cuisineTerms(cuisines: string[]): string[] {
	return cuisines.flatMap((c) => c.split(',').map((part) => part.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// A place
// ---------------------------------------------------------------------------

export interface PlaceDetail {
	place: Place;
	visits: VisitDetail[];
}

export async function getPlace(id: number): Promise<PlaceDetail | null> {
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select(PLACE_COLUMNS)
		.eq('id', id)
		.maybeSingle();
	if (error) throw new Error(error.message);
	if (!data) return null;

	const { data: visitRows, error: visitError } = await supabasePublic
		.from('restaurant_diary')
		.select('*')
		.eq('restaurant_id', id)
		.order('visited_on', { ascending: false })
		.order('id', { ascending: false });
	if (visitError) throw new Error(visitError.message);

	const visits = (visitRows ?? []) as DiaryVisit[];
	const photos = await photosForVisits(visits.map((v) => v.id));
	return {
		place: data as Place,
		visits: visits.map((v) => ({ ...v, photos: photos.get(v.id) ?? [] })),
	};
}

export async function getVisit(id: number, includePrivate = false): Promise<VisitDetail | null> {
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('*')
		.eq('id', id)
		.maybeSingle();
	if (error) throw new Error(error.message);
	if (!data) return null;
	// The private note lives on the base table, never in the anon-readable
	// restaurant_diary view — so a visitor's DiaryVisit can't carry it. Fetch it
	// with the service role only once the caller has proved it is the owner.
	const privateNote = includePrivate ? await getVisitPrivateNote(id) : null;
	const photos = await photosForVisits([id]);
	return { ...(data as DiaryVisit), private_note: privateNote, photos: photos.get(id) ?? [] };
}

/** The owner-only note for one visit, off the base table. Null if the column
 *  isn't there yet (an environment behind on 0054) rather than throwing. */
async function getVisitPrivateNote(id: number): Promise<string | null> {
	const { data, error } = await supabaseAdmin
		.from('restaurant_visits')
		.select('private_note')
		.eq('id', id)
		.maybeSingle();
	if (error) return null;
	return (data as { private_note?: string | null } | null)?.private_note ?? null;
}

// ---------------------------------------------------------------------------
// The diary
// ---------------------------------------------------------------------------

export interface DiaryMonth {
	/** "YYYY-MM". */
	key: string;
	label: string;
	visits: DiaryVisit[];
	places: number;
}

export async function listDiary(limit = 400): Promise<DiaryVisit[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('*')
		.order('visited_on', { ascending: false })
		.order('id', { ascending: false })
		.limit(limit);
	if (error) throw new Error(error.message);
	return (data ?? []) as DiaryVisit[];
}

export function groupByMonth(visits: DiaryVisit[]): DiaryMonth[] {
	const months = new Map<string, DiaryVisit[]>();
	for (const v of visits) {
		const key = v.visited_on.slice(0, 7);
		months.set(key, [...(months.get(key) ?? []), v]);
	}
	return [...months.entries()]
		.sort((a, b) => b[0].localeCompare(a[0]))
		.map(([key, rows]) => ({
			key,
			label: monthLabel(key),
			visits: rows,
			places: new Set(rows.map((r) => r.restaurant_id)).size,
		}));
}

/** Visits in one "YYYY-MM", oldest first — the month card reads forwards. */
export async function listMonthVisits(key: string): Promise<VisitDetail[]> {
	const [y, m] = key.split('-').map(Number);
	if (!y || !m) return [];
	const start = `${key}-01`;
	const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('*')
		.gte('visited_on', start)
		.lt('visited_on', end)
		.order('visited_on')
		.order('id');
	if (error) throw new Error(error.message);
	const visits = (data ?? []) as DiaryVisit[];
	const photos = await photosForVisits(visits.map((v) => v.id));
	return visits.map((v) => ({ ...v, photos: photos.get(v.id) ?? [] }));
}

/** Every month that has a visit in it, newest first. */
export async function listMonthKeys(): Promise<string[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('visited_on')
		.order('visited_on', { ascending: false });
	if (error) throw new Error(error.message);
	const keys = new Set((data ?? []).map((r: { visited_on: string }) => r.visited_on.slice(0, 7)));
	return [...keys];
}

/**
 * What the month card needs to know about the places it is about, beyond the
 * visits themselves: whether each was new, and where it is.
 *
 * "New" has to be answered against the whole diary, not against the month: a
 * place I have been going to for years is not new in August because August is
 * all the card can see. `first_visit` is `min(visited_on)` over every visit in
 * the place view, so a month containing it is the month the place was new in.
 *
 * The point comes along for the ride because the card draws a map of a place
 * whenever a meal there went unphotographed, and it is the same row.
 */
export interface MonthPlace {
	isNew: boolean;
	lat: number | null;
	lng: number | null;
}

export async function placesForMonth(
	placeIds: number[],
	key: string,
): Promise<Map<number, MonthPlace>> {
	const ids = [...new Set(placeIds)].filter((id) => Number.isInteger(id) && id > 0);
	if (ids.length === 0) return new Map();
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select('id,first_visit,lat,lng')
		.in('id', ids);
	if (error) throw new Error(error.message);
	const rows = (data ?? []) as {
		id: number;
		first_visit: string | null;
		lat: number | null;
		lng: number | null;
	}[];
	return new Map(
		rows.map((r) => [
			r.id,
			{ isNew: r.first_visit?.startsWith(key) ?? false, lat: r.lat, lng: r.lng },
		]),
	);
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/** Places whose name contains `query`, for the composer's search field. */
export async function searchPlaces(query: string, limit = 6): Promise<Place[]> {
	const q = query.trim();
	if (!q) return [];
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select(PLACE_COLUMNS)
		.ilike('name', `%${q}%`)
		.order('visit_count', { ascending: false })
		.limit(limit);
	if (error) throw new Error(error.message);
	return (data ?? []) as Place[];
}

/**
 * What logging another meal somewhere inherits from the last one there. Only
 * the answers that tend to hold from one visit to the next: the verdict and the
 * heart are what you already decided about the place. The DATE is not among
 * them — logging another meal means one you ate today.
 *
 * The rating carries too. Somewhere you go back to is usually as good as it
 * was, so the last number is a better starting point than a blank row — and
 * the composer shows what it carried, so disagreeing with it is one click.
 */
export interface PreviousVisit {
	rating: number | null;
	verdict: number | null;
	hearted: boolean;
}

/**
 * The most recent visit at each of `placeIds`.
 *
 * Not the place row's `latest_verdict` and `hearted`, near as they look: those
 * answer "the last verdict I recorded" and "loved on ANY visit", so together
 * they can describe a pair of visits that never happened. One visit's answers
 * have to come from one visit.
 */
export async function previousVisits(placeIds: number[]): Promise<Map<number, PreviousVisit>> {
	const ids = [...new Set(placeIds)].filter((id) => Number.isInteger(id) && id > 0);
	if (ids.length === 0) return new Map();
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('restaurant_id, visited_on, rating, verdict, hearted')
		.in('restaurant_id', ids)
		.order('visited_on', { ascending: false })
		.order('id', { ascending: false });
	if (error) throw new Error(error.message);

	// Sorted newest first, so the first row seen for a place is its last visit.
	const latest = new Map<number, PreviousVisit>();
	for (const row of (data ?? []) as {
		restaurant_id: number;
		visited_on: string;
		rating: number | null;
		verdict: number | null;
		hearted: boolean;
	}[]) {
		if (latest.has(row.restaurant_id)) continue;
		latest.set(row.restaurant_id, {
			rating: row.rating,
			verdict: row.verdict,
			hearted: row.hearted,
		});
	}
	return latest;
}

async function distinctTextArray(column: 'tags' | 'friends'): Promise<string[]> {
	const { data, error } = await supabasePublic.from('restaurant_diary').select(column);
	if (error) throw new Error(error.message);
	const seen = new Map<string, string>();
	for (const row of (data ?? []) as Record<string, string[]>[]) {
		for (const value of row[column] ?? []) {
			const key = value.toLowerCase();
			if (!seen.has(key)) seen.set(key, value);
		}
	}
	return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en'));
}

export const listTags = () => distinctTextArray('tags');
export const listFriends = () => distinctTextArray('friends');

/** Cuisines already in use, for the composer's controlled list. */
export async function listCuisines(): Promise<string[]> {
	const { data, error } = await supabasePublic.from('restaurants').select('cuisines');
	if (error) throw new Error(error.message);
	const seen = new Map<string, string>();
	for (const row of (data ?? []) as { cuisines: string[] }[]) {
		for (const c of row.cuisines) if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
	}
	return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en'));
}

// ---------------------------------------------------------------------------
// Writes (owner only — every caller checks requireOwner first)
// ---------------------------------------------------------------------------

/** Counts per why-tag, in the fixed vocabulary's order, zeroes dropped. */
export async function listWhyTagFacets(scope: PlaceScope = 'to-try'): Promise<CuisineFacet[]> {
	const { data, error } = await inScope(
		supabasePublic.from('restaurant_places').select('to_try_tags'),
		scope,
	);
	if (error) throw new Error(error.message);
	const counts = new Map<string, number>();
	for (const row of (data ?? []) as { to_try_tags: string[] }[]) {
		for (const t of new Set(row.to_try_tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	// The vocabulary's own order, not frequency: it is eight fixed words in a
	// row, and a row that reorders itself as you tag things is a row you have
	// to re-read every time.
	return WHY_TAGS.filter((t) => counts.has(t)).map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

export interface PlaceInput {
	/**
	 * OPTIONAL, AND OMITTING IT MEANS "LEAVE THE NAME ALONE".
	 *
	 * It used to be required, and `placePayload` wrote it unconditionally, so
	 * any edit that carried something else and no name — a location, a price
	 * band — renamed the place to the empty string on its way past. Nothing
	 * did that until the place dialog started PATCHing coordinates by
	 * themselves, but it was one caller away the whole time.
	 *
	 * Creating still needs one: see `createPlace`, which asks for it in its
	 * own signature rather than making every edit carry a name it isn't
	 * changing.
	 */
	name?: string;
	cuisines?: string[];
	priceBand?: PriceBand | null;
	neighborhood?: string | null;
	city?: string | null;
	stateRegion?: string | null;
	country?: string | null;
	lat?: number | null;
	lng?: number | null;
	googlePlaceId?: string | null;
	websiteUrl?: string | null;
	yelpUrl?: string | null;
	beliUrl?: string | null;
	toTryReason?: string | null;
	trip?: boolean;
	toTryTags?: string[];
	/** Put the place on the to-try list (a place with no visits yet). */
	toTry?: boolean;
}

function placePayload(input: PlaceInput): Record<string, unknown> {
	const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
	if (input.name !== undefined) payload.name = input.name.trim();
	if (input.cuisines !== undefined) payload.cuisines = input.cuisines.map((c) => c.trim()).filter(Boolean);
	if (input.priceBand !== undefined) payload.price_band = input.priceBand;
	if (input.neighborhood !== undefined) payload.neighborhood = emptyToNull(input.neighborhood);
	// City and country have a NOT NULL floor; only overwrite them when given.
	if (input.city) payload.city = input.city.trim();
	if (input.stateRegion !== undefined) payload.state_region = emptyToNull(input.stateRegion);
	if (input.country) payload.country = input.country.trim();
	if (input.lat !== undefined) payload.lat = input.lat;
	if (input.lng !== undefined) payload.lng = input.lng;
	if (input.googlePlaceId !== undefined) payload.google_place_id = emptyToNull(input.googlePlaceId);
	if (input.websiteUrl !== undefined) payload.website_url = emptyToNull(input.websiteUrl);
	if (input.yelpUrl !== undefined) payload.yelp_url = emptyToNull(input.yelpUrl);
	if (input.beliUrl !== undefined) payload.beli_url = emptyToNull(input.beliUrl);
	if (input.toTryReason !== undefined) payload.to_try_reason = emptyToNull(input.toTryReason);
	if (input.trip !== undefined) payload.trip = input.trip;
	if (input.toTryTags !== undefined) payload.to_try_tags = input.toTryTags.filter(isWhyTag);
	if (input.toTry) payload.to_try_added_at = new Date().toISOString();
	return payload;
}

function emptyToNull(v: string | null | undefined): string | null {
	if (v == null) return null;
	const trimmed = v.trim();
	return trimmed === '' ? null : trimmed;
}

export async function createPlace(input: PlaceInput & { name: string }): Promise<Place> {
	const payload = placePayload(input);
	// City is NOT NULL and the composer's fast path ("a name and nothing else")
	// has to stay open, so an unplaced new place lands in the owner's own city
	// rather than failing the insert. Editing the place fixes it later.
	if (!payload.city) payload.city = 'New York';
	if (!payload.country) payload.country = 'US';
	const { data, error } = await supabaseAdmin.from('restaurants').insert(payload).select('id').single();
	if (error) throw new Error(error.message);
	const place = await getPlaceRow(data.id as number);
	if (!place) throw new Error('created place could not be read back');
	return place;
}

export async function updatePlace(id: number, input: PlaceInput): Promise<void> {
	const { error } = await supabaseAdmin.from('restaurants').update(placePayload(input)).eq('id', id);
	if (error) throw new Error(error.message);
}

async function getPlaceRow(id: number): Promise<Place | null> {
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select(PLACE_COLUMNS)
		.eq('id', id)
		.maybeSingle();
	if (error) throw new Error(error.message);
	return (data as Place) ?? null;
}

export interface VisitInput {
	restaurantId: number;
	visitedOn?: string | null;
	rating?: number | null;
	verdict?: number | null;
	hearted?: boolean;
	revisit?: boolean;
	friends?: string[];
	review?: string | null;
	privateNote?: string | null;
	tags?: string[];
}

export async function createVisit(input: VisitInput): Promise<number> {
	const { data, error } = await supabaseAdmin
		.from('restaurant_visits')
		.insert({
			restaurant_id: input.restaurantId,
			visited_on: input.visitedOn ?? siteDay(),
			rating: input.rating ?? null,
			verdict: input.verdict ?? null,
			hearted: input.hearted ?? false,
			revisit: input.revisit ?? false,
			friends: cleanList(input.friends),
			review: emptyToNull(input.review),
			private_note: emptyToNull(input.privateNote),
			tags: cleanList(input.tags),
		})
		.select('id')
		.single();
	if (error) throw new Error(error.message);
	return data.id as number;
}

export async function updateVisit(id: number, input: Omit<VisitInput, 'restaurantId'>): Promise<void> {
	const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
	if (input.visitedOn) payload.visited_on = input.visitedOn;
	if (input.rating !== undefined) payload.rating = input.rating;
	if (input.verdict !== undefined) payload.verdict = input.verdict;
	if (input.hearted !== undefined) payload.hearted = input.hearted;
	if (input.revisit !== undefined) payload.revisit = input.revisit;
	if (input.friends !== undefined) payload.friends = cleanList(input.friends);
	if (input.review !== undefined) payload.review = emptyToNull(input.review);
	if (input.privateNote !== undefined) payload.private_note = emptyToNull(input.privateNote);
	if (input.tags !== undefined) payload.tags = cleanList(input.tags);
	const { error } = await supabaseAdmin.from('restaurant_visits').update(payload).eq('id', id);
	if (error) throw new Error(error.message);
}

/** Soft delete, so the photographs survive an undo. */
export async function deleteVisit(id: number): Promise<void> {
	const { error } = await supabaseAdmin
		.from('restaurant_visits')
		.update({ deleted_at: new Date().toISOString() })
		.eq('id', id);
	if (error) throw new Error(error.message);
}

function cleanList(values: string[] | undefined): string[] {
	if (!values) return [];
	const seen = new Map<string, string>();
	for (const v of values) {
		const trimmed = v.trim();
		if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
	}
	return [...seen.values()];
}

/**
 * Heart a place.
 *
 * The heart belongs to a VISIT — it is per-meal, alongside that meal's rating
 * and verdict. A place shows as hearted when any of its visits is. So hearting
 * from the place page writes to the latest visit, which is the one whose
 * opinion the page is already showing, and un-hearting clears every visit,
 * because "no longer love it" is not a claim about one meal.
 */
export async function setPlaceHearted(id: number, hearted: boolean): Promise<void> {
	if (!hearted) {
		const { error } = await supabaseAdmin
			.from('restaurant_visits')
			.update({ hearted: false })
			.eq('restaurant_id', id);
		if (error) throw new Error(error.message);
		return;
	}
	const { data, error: findError } = await supabaseAdmin
		.from('restaurant_visits')
		.select('id')
		.eq('restaurant_id', id)
		.is('deleted_at', null)
		.order('visited_on', { ascending: false })
		.order('id', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (findError) throw new Error(findError.message);
	if (!data) throw new Error('cannot heart a place with no visits');
	const { error } = await supabaseAdmin
		.from('restaurant_visits')
		.update({ hearted: true })
		.eq('id', data.id);
	if (error) throw new Error(error.message);
}

/**
 * Take a place off the to-try list.
 *
 * There are two ways to leave that list and they want different things done.
 * A place you have now EATEN AT leaves it by having a visit — the view's
 * `on_to_try` already goes false on its own — and the row has to stay, because
 * it is the restaurant every one of those visits points at. A place you have
 * simply CHANGED YOUR MIND ABOUT has no visits, no photographs and no history:
 * clearing the two to-try columns would leave a row that appears on no page in
 * the section, since the Restaurants list is `visit_count > 0` and the to-try
 * list is `to_try_added_at is not null`. That is not removal, it is a leak.
 *
 * So the visit count decides. Any visit at all — including a soft-deleted one,
 * whose row is still there and still points here — and the place is unlisted
 * and kept. None, and the row goes, which is what "remove it" meant.
 *
 * Returns which of the two happened, so a caller can say so.
 */
export async function removeFromToTry(id: number): Promise<'deleted' | 'unlisted'> {
	const { count, error: countError } = await supabaseAdmin
		.from('restaurant_visits')
		.select('id', { count: 'exact', head: true })
		.eq('restaurant_id', id);
	if (countError) throw new Error(countError.message);

	if ((count ?? 0) === 0) {
		const { error } = await supabaseAdmin.from('restaurants').delete().eq('id', id);
		if (error) throw new Error(error.message);
		return 'deleted';
	}

	const { error } = await supabaseAdmin
		.from('restaurants')
		.update({ to_try_added_at: null, to_try_reason: null })
		.eq('id', id);
	if (error) throw new Error(error.message);
	return 'unlisted';
}

export interface PhotoInput {
	storagePath: string;
	caption?: string | null;
	width?: number | null;
	height?: number | null;
}

/** The ids of the rows just written, in the order they were given. */
export async function addPhotos(visitId: number, photos: PhotoInput[]): Promise<number[]> {
	if (photos.length === 0) return [];
	const { data, error: maxError } = await supabaseAdmin
		.from('restaurant_photos')
		.select('position')
		.eq('visit_id', visitId)
		.order('position', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (maxError) throw new Error(maxError.message);
	const start = (data?.position ?? -1) + 1;
	const { data: rows, error } = await supabaseAdmin
		.from('restaurant_photos')
		.insert(
			photos.map((p, i) => ({
				visit_id: visitId,
				storage_path: p.storagePath,
				caption: emptyToNull(p.caption),
				width: p.width ?? null,
				height: p.height ?? null,
				position: start + i,
			})),
		)
		// Returned so the composer can put a just-uploaded photograph in the
		// arrangement it was placed into, rather than only at the end.
		.select('id, position');
	if (error) throw new Error(error.message);
	return ((rows ?? []) as { id: number; position: number }[])
		.sort((a, b) => a.position - b.position)
		.map((r) => r.id);
}

/**
 * Rearrange a visit's photographs. `ids` is the whole visit in the order it
 * should read — anything left out keeps whatever position it had, which is
 * why the composer sends the complete list. An id belonging to another visit
 * is refused rather than quietly moved.
 */
export async function reorderPhotos(visitId: number, ids: number[]): Promise<void> {
	if (ids.length === 0) return;
	const { data, error: readError } = await supabaseAdmin
		.from('restaurant_photos')
		.select('id')
		.eq('visit_id', visitId);
	if (readError) throw new Error(readError.message);
	const mine = new Set(((data ?? []) as { id: number }[]).map((r) => r.id));
	const stray = ids.find((id) => !mine.has(id));
	if (stray != null) throw new Error(`photograph ${stray} does not belong to this visit`);

	// One update per row: positions are a handful of small integers, and the
	// alternative — an upsert of whole rows — would need every column resent.
	for (let i = 0; i < ids.length; i++) {
		const { error } = await supabaseAdmin
			.from('restaurant_photos')
			.update({ position: i })
			.eq('id', ids[i]);
		if (error) throw new Error(error.message);
	}
}

/** Upload a photo to the bucket and return its storage path. */
export async function uploadPhoto(
	visitId: number,
	file: File | Blob,
	filename: string,
): Promise<string> {
	const ext = (filename.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
	const path = `${visitId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
	const bytes = new Uint8Array(await file.arrayBuffer());
	await putPhoto(path, bytes, file instanceof File ? file.type || undefined : undefined);
	return path;
}

export async function deletePhoto(id: number): Promise<void> {
	const { data, error: readError } = await supabaseAdmin
		.from('restaurant_photos')
		.select('storage_path')
		.eq('id', id)
		.maybeSingle();
	if (readError) throw new Error(readError.message);
	const { error } = await supabaseAdmin.from('restaurant_photos').delete().eq('id', id);
	if (error) throw new Error(error.message);
	if (data?.storage_path) {
		await deletePhotoObject(data.storage_path as string);
	}
}
