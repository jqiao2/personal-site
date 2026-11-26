// The photo inbox: food from the owner's camera roll with no visit yet. Rows and
// objects arrive from scripts/food-inbox on the owner's PC; this is everything
// that happens to them afterwards. Every call runs on the service role, so every
// caller is behind requireOwner().
import { boxAround, groupMeals, meters, type InboxPhoto, type Meal } from './food-inbox-group';
import { normalize, SOURCE_LABELS, titleCaseName } from './gazetteer';
import type { GeoHit } from './place-lookup';
import { addPhotos, previousVisits, uploadPhoto, type PreviousVisit } from './restaurants';
import { supabaseAdmin, supabasePublic } from './supabase';

const BUCKET = 'food-inbox';

/** How far from the photograph a restaurant may be and still be suggested. */
const RADIUS_M = 150;

const SUGGESTIONS = 8;

// PostgREST answers with at most this many rows per request.
const PAGE = 1000;

/** Never throws: a count in a sidebar must not take the feed down with it. */
export async function countPending(): Promise<number> {
	const { count } = await supabaseAdmin
		.from('food_inbox')
		.select('id', { count: 'exact', head: true })
		.eq('status', 'pending');

	return count ?? 0;
}

interface PendingRow {
	id: number;
	width: number;
	height: number;
	taken_at: string;
	lat: number | null;
	lng: number | null;
}

/** Everything waiting, grouped into meals, newest first. */
export async function listPendingMeals(): Promise<Meal[]> {
	const photos: InboxPhoto[] = [];

	for (let from = 0; ; from += PAGE) {
		const { data, error } = await supabaseAdmin
			.from('food_inbox')
			.select('id, width, height, taken_at, lat, lng')
			.eq('status', 'pending')
			.order('id')
			.range(from, from + PAGE - 1);

		if (error) throw new Error(error.message);

		// SAFETY: the select above names exactly these columns.
		const rows = (data ?? []) as PendingRow[];

		for (const r of rows) {
			photos.push({
				id: r.id,
				url: `/api/restaurants/inbox/${r.id}`,
				width: r.width,
				height: r.height,
				takenAt: r.taken_at,
				lat: r.lat,
				lng: r.lng,
			});
		}

		if (rows.length < PAGE) return groupMeals(photos);
	}
}

/** A place already in the log, in the shape the meal composer opens on. */
export interface LoggedSuggestion {
	kind: 'logged';
	distance: number;
	label: string;
	place: {
		id: number;
		name: string;
		meta: string;
		visits: number;
		trip: boolean;
		previous: PreviousVisit | null;
	};
}

export interface NewSuggestion {
	kind: 'new';
	distance: number;
	label: string;
	hit: GeoHit;
}

export type Suggestion = LoggedSuggestion | NewSuggestion;

/**
 * Where a photograph was probably taken, nearest first. Places already in the
 * log count as half as far: in a block of forty kitchens, the one I have eaten
 * at or meant to is the better guess.
 */
export async function suggestPlaces(point: { lat: number; lng: number }): Promise<Suggestion[]> {
	const box = boxAround(point, RADIUS_M);

	const [logged, sources] = await Promise.all([
		supabasePublic
			.from('restaurant_places')
			.select('id, name, cuisines, neighborhood, city, lat, lng, trip, visit_count')
			.gte('lat', box.south)
			.lte('lat', box.north)
			.gte('lng', box.west)
			.lte('lng', box.east),
		supabasePublic
			.from('place_sources')
			.select('source, name, lat, lng, address, locality, city, region, country, cuisines')
			.gte('lat', box.south)
			.lte('lat', box.north)
			.gte('lng', box.west)
			.lte('lng', box.east),
	]);

	if (logged.error) throw new Error(logged.error.message);

	if (sources.error) throw new Error(sources.error.message);

	const previous = await previousVisits(logged.data.map((p) => p.id));

	const mine = logged.data.map((p): LoggedSuggestion => {
		const where = p.neighborhood ? `${p.neighborhood}, ${p.city}` : p.city;

		return {
			kind: 'logged',
			distance: meters(point, p),
			label: p.visit_count > 0 ? `${p.visit_count} visit${p.visit_count === 1 ? '' : 's'}` : 'to try',
			place: {
				id: p.id,
				name: p.name,
				meta: [p.cuisines[0], where].filter(Boolean).join(' · '),
				visits: p.visit_count,
				trip: p.trip,
				previous: previous.get(p.id) ?? null,
			},
		};
	});

	// Three sources name the same kitchen three times; the nearest stands for
	// all of them, and the log's own row beats any.
	const seen = new Set(mine.map((s) => normalize(s.place.name)));
	const others: NewSuggestion[] = [];

	const byDistance = sources.data
		.map((s) => ({ ...s, distance: meters(point, s) }))
		.sort((a, b) => a.distance - b.distance);

	for (const s of byDistance) {
		const key = normalize(s.name);

		if (seen.has(key)) continue;
		seen.add(key);
		const name = /[a-z]/.test(s.name) ? s.name : titleCaseName(s.name);
		const sourceLabel = new Map<string, string>(Object.entries(SOURCE_LABELS)).get(s.source) ?? s.source;

		others.push({
			kind: 'new',
			distance: s.distance,
			label: sourceLabel,
			hit: {
				source: s.source,
				sourceLabel,
				name,
				display: [name, s.address, s.locality].filter(Boolean).join(', '),
				lat: s.lat,
				lng: s.lng,
				neighborhood: s.locality,
				city: s.city,
				stateRegion: s.region,
				country: s.country,
				kind: null,
				cuisines: s.cuisines ?? [],
				address: s.address ?? '',
				precise: true,
			},
		});
	}

	const weight = (s: Suggestion) => (s.kind === 'logged' ? s.distance / 2 : s.distance);

	return [...mine, ...others]
		.filter((s) => s.distance <= RADIUS_M)
		.sort((a, b) => weight(a) - weight(b))
		.slice(0, SUGGESTIONS);
}

export interface DayVisit {
	id: number;
	name: string;
	photos: number;
}

/** Visits already logged on any of `days`, by day. */
export async function visitsOn(days: string[]): Promise<Map<string, DayVisit[]>> {
	const byDay = new Map<string, DayVisit[]>();

	if (days.length === 0) return byDay;

	const { data, error } = await supabasePublic
		.from('restaurant_diary')
		.select('id, visited_on, restaurant_name, photo_count')
		.in('visited_on', [...new Set(days)])
		.order('id');

	if (error) throw new Error(error.message);

	for (const v of data) {
		const list = byDay.get(v.visited_on) ?? [];
		list.push({ id: v.id, name: v.restaurant_name, photos: v.photo_count });
		byDay.set(v.visited_on, list);
	}

	return byDay;
}

async function pendingObject(id: number) {
	const { data, error } = await supabaseAdmin
		.from('food_inbox')
		.select('storage_path, width, height, taken_at')
		.eq('id', id)
		.eq('status', 'pending')
		.maybeSingle();

	if (error) throw new Error(error.message);

	return data?.storage_path ? { path: String(data.storage_path), width: data.width, height: data.height, takenAt: String(data.taken_at) } : null;
}

async function download(path: string): Promise<Blob> {
	const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);

	if (error) throw new Error(error.message);

	return data;
}

/** The photograph itself, or null when it is no longer waiting. */
export async function readPending(id: number): Promise<Blob | null> {
	const photo = await pendingObject(id);

	return photo ? download(photo.path) : null;
}

/** Take a row off the page. False when someone already had. */
async function settle(id: number, status: 'logged' | 'dismissed', visitId: number | null): Promise<boolean> {
	const { data, error } = await supabaseAdmin
		.from('food_inbox')
		.update({ status, visit_id: visitId, storage_path: null })
		.eq('id', id)
		.eq('status', 'pending')
		.select('id');

	if (error) throw new Error(error.message);

	return data.length > 0;
}

/**
 * Move a photograph onto a visit. Claimed before it is copied, so a double
 * press cannot attach it twice, and handed back if the copy fails.
 * Returns the new restaurant_photos ids, or null when it is not waiting.
 */
export async function logPending(id: number, visitId: number): Promise<number[] | null> {
	const photo = await pendingObject(id);

	if (!photo) return null;
	const blob = await download(photo.path);

	if (!(await settle(id, 'logged', visitId))) return null;
	let ids: number[];

	try {
		const file = new File([blob], 'photo.webp', { type: 'image/webp' });
		const storagePath = await uploadPhoto(visitId, file, file.name);
		ids = await addPhotos(visitId, [{ storagePath, width: photo.width, height: photo.height }]);
	} catch (e) {
		await supabaseAdmin
			.from('food_inbox')
			.update({ status: 'pending', visit_id: null, storage_path: photo.path })
			.eq('id', id);
		throw e;
	}

	// The visit's time is its earliest photograph: same-day visits sort by it.
	await supabaseAdmin
		.from('restaurant_visits')
		.update({ eaten_at: photo.takenAt })
		.eq('id', visitId)
		.or(`eaten_at.is.null,eaten_at.gt.${photo.takenAt}`);

	// The photograph is safely on the visit; a leftover copy is only bytes.
	await supabaseAdmin.storage.from(BUCKET).remove([photo.path]);

	return ids;
}

/** Not food, or not worth logging. The row stays so the sync never offers it again. */
export async function dismissPending(id: number): Promise<boolean> {
	const photo = await pendingObject(id);

	if (!photo || !(await settle(id, 'dismissed', null))) return false;
	await supabaseAdmin.storage.from(BUCKET).remove([photo.path]);

	return true;
}
