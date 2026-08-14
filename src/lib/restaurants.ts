// Service layer for the restaurant log, between the pages/API routes and
// Supabase. Reads go through the anon client (the tables are publicly readable,
// like the film log's); writes go through the service-role client and are only
// ever called after requireOwner().
import { supabaseAdmin, supabasePublic } from './supabase';
import { siteDay, siteYear } from './day';
import { monthLabel } from './share-card';

export const PHOTO_BUCKET = 'restaurant-photos';

/** The four price bands, in order. Four steps, no half steps. */
export const PRICE_BANDS = ['$', '$$', '$$$', '$$$$'] as const;
export type PriceBand = (typeof PRICE_BANDS)[number];

export function isPriceBand(v: unknown): v is PriceBand {
	return typeof v === 'string' && (PRICE_BANDS as readonly string[]).includes(v);
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
	favorite_rank: number | null;
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
	tags: string[];
	restaurant_name: string;
	cuisines: string[];
	price_band: PriceBand | null;
	neighborhood: string | null;
	city: string;
	state_region: string | null;
	country: string;
	photo_count: number;
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
	return supabasePublic.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath).data.publicUrl;
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
export async function listFavorites(): Promise<Place[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select(PLACE_COLUMNS)
		.not('favorite_rank', 'is', null)
		.order('favorite_rank');
	if (error) throw new Error(error.message);
	return (data ?? []) as Place[];
}

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

export type PlaceSort = 'recent' | 'rating' | 'verdict' | 'name';

export function isPlaceSort(v: unknown): v is PlaceSort {
	return v === 'recent' || v === 'rating' || v === 'verdict' || v === 'name';
}

export interface PlaceQuery {
	cuisines?: string[];
	prices?: PriceBand[];
	/** "This rung or better", as a rank. 5 (Avoid) means no threshold at all. */
	verdictAtLeast?: number | null;
	city?: string | null;
	sort?: PlaceSort;
}

/**
 * Every place I've eaten at, filtered. Fetched whole and filtered in memory:
 * this is a personal log in the low hundreds of rows, and doing it here keeps
 * the multi-valued cuisine match and the "or better" verdict threshold in one
 * readable place instead of split across PostgREST operators.
 */
export async function listPlaces(query: PlaceQuery = {}): Promise<Place[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select(PLACE_COLUMNS)
		.gt('visit_count', 0);
	if (error) throw new Error(error.message);
	let rows = (data ?? []) as Place[];

	if (query.cuisines?.length) {
		const want = new Set(query.cuisines.map((c) => c.toLowerCase()));
		rows = rows.filter((r) => r.cuisines.some((c) => want.has(c.toLowerCase())));
	}
	if (query.prices?.length) {
		const want = new Set<string>(query.prices);
		rows = rows.filter((r) => r.price_band != null && want.has(r.price_band));
	}
	if (query.verdictAtLeast != null && query.verdictAtLeast < 5) {
		const max = query.verdictAtLeast;
		rows = rows.filter((r) => r.latest_verdict != null && r.latest_verdict <= max);
	}
	if (query.city) {
		const want = query.city.toLowerCase();
		rows = rows.filter((r) => r.city.toLowerCase() === want);
	}

	return sortPlaces(rows, query.sort ?? 'recent');
}

function sortPlaces(rows: Place[], sort: PlaceSort): Place[] {
	const byName = (a: Place, b: Place) => a.name.localeCompare(b.name, 'en');
	const copy = [...rows];
	switch (sort) {
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

/**
 * The list view's sections. Places with a neighbourhood group under it; places
 * without group under their city, which is the level of detail those places
 * warrant. Sections lead with the one visited most recently.
 */
export interface PlaceGroup {
	key: string;
	title: string;
	/** The wider place — "Brooklyn" under "Sunset Park", "TX" under "Austin". */
	subtitle: string;
	places: Place[];
}

export function groupPlaces(places: Place[]): PlaceGroup[] {
	const groups = new Map<string, PlaceGroup>();
	for (const p of places) {
		const title = p.neighborhood ?? p.city;
		const subtitle = p.neighborhood ? p.city : (p.state_region ?? p.country);
		const key = `${title}|${subtitle}`;
		const group = groups.get(key) ?? { key, title, subtitle, places: [] };
		group.places.push(p);
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => {
		const recency = (g: PlaceGroup) =>
			g.places.reduce((max, p) => (p.last_visit && p.last_visit > max ? p.last_visit : max), '');
		return recency(b).localeCompare(recency(a)) || b.places.length - a.places.length;
	});
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
export async function listCuisineFacets(): Promise<CuisineFacet[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select('cuisines')
		.gt('visit_count', 0);
	if (error) throw new Error(error.message);
	const counts = new Map<string, number>();
	for (const row of (data ?? []) as { cuisines: string[] }[]) {
		for (const c of row.cuisines) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));
}

export interface CityFacet {
	name: string;
	count: number;
	lat: number | null;
	lng: number | null;
}

/**
 * Cities with their counts and a centre, biggest first.
 *
 * This is what answers the map's viewport problem: eighty per cent of the pins
 * are one dense New York cluster and the rest are scattered across four other
 * cities, so fitting the bounds gives a world map with five specks. The map
 * opens on the biggest city and lists the others beside it.
 */
export async function listCityFacets(): Promise<CityFacet[]> {
	const { data, error } = await supabasePublic
		.from('restaurant_places')
		.select('city,lat,lng,visit_count')
		.gt('visit_count', 0);
	if (error) throw new Error(error.message);
	const rows = (data ?? []) as { city: string; lat: number | null; lng: number | null }[];
	const cities = new Map<string, { count: number; lat: number; lng: number; placed: number }>();
	for (const r of rows) {
		const entry = cities.get(r.city) ?? { count: 0, lat: 0, lng: 0, placed: 0 };
		entry.count += 1;
		if (r.lat != null && r.lng != null) {
			entry.lat += r.lat;
			entry.lng += r.lng;
			entry.placed += 1;
		}
		cities.set(r.city, entry);
	}
	return [...cities.entries()]
		.map(([name, e]) => ({
			name,
			count: e.count,
			lat: e.placed ? e.lat / e.placed : null,
			lng: e.placed ? e.lng / e.placed : null,
		}))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));
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

export async function getVisit(id: number): Promise<VisitDetail | null> {
	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('*')
		.eq('id', id)
		.maybeSingle();
	if (error) throw new Error(error.message);
	if (!data) return null;
	const photos = await photosForVisits([id]);
	return { ...(data as DiaryVisit), photos: photos.get(id) ?? [] };
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
 * Set (or clear) a place's rank in the hand-picked top four. Ranks are unique,
 * so taking a rank another place holds moves that place out of the block rather
 * than failing on the unique index.
 */
export async function setFavoriteRank(id: number, rank: number | null): Promise<void> {
	if (rank != null) {
		const { error: clearError } = await supabaseAdmin
			.from('restaurants')
			.update({ favorite_rank: null })
			.eq('favorite_rank', rank)
			.neq('id', id);
		if (clearError) throw new Error(clearError.message);
	}
	const { error } = await supabaseAdmin.from('restaurants').update({ favorite_rank: rank }).eq('id', id);
	if (error) throw new Error(error.message);
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

export async function addPhotos(visitId: number, photos: PhotoInput[]): Promise<void> {
	if (photos.length === 0) return;
	const { data, error: maxError } = await supabaseAdmin
		.from('restaurant_photos')
		.select('position')
		.eq('visit_id', visitId)
		.order('position', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (maxError) throw new Error(maxError.message);
	const start = (data?.position ?? -1) + 1;
	const { error } = await supabaseAdmin.from('restaurant_photos').insert(
		photos.map((p, i) => ({
			visit_id: visitId,
			storage_path: p.storagePath,
			caption: emptyToNull(p.caption),
			width: p.width ?? null,
			height: p.height ?? null,
			position: start + i,
		})),
	);
	if (error) throw new Error(error.message);
}

/** Upload a photo to the bucket and return its storage path. */
export async function uploadPhoto(
	visitId: number,
	file: File | Blob,
	filename: string,
): Promise<string> {
	const ext = (filename.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
	const path = `${visitId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
	const { error } = await supabaseAdmin.storage.from(PHOTO_BUCKET).upload(path, file, {
		contentType: file instanceof File ? file.type || undefined : undefined,
		upsert: false,
	});
	if (error) throw new Error(error.message);
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
		await supabaseAdmin.storage.from(PHOTO_BUCKET).remove([data.storage_path as string]);
	}
}
