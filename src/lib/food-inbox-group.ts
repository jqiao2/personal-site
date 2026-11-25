// The arithmetic behind /restaurants/inbox, free of any database so
// scripts/food-inbox.test.mjs can run it under plain node.

/** Two photographs this close in time, and not far apart, are one meal. */
const MEAL_GAP_MS = 90 * 60 * 1000;

/** A phone's fix indoors wanders; two tables on one block do not. */
const MEAL_SPAN_M = 250;

export interface InboxPhoto {
	id: number;
	url: string;
	width: number;
	height: number;
	/** Zoneless, "YYYY-MM-DDTHH:MM:SS": the camera's clock. */
	takenAt: string;
	lat: number | null;
	lng: number | null;
}

export interface Meal {
	day: string;
	photos: InboxPhoto[];
	point: { lat: number; lng: number } | null;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const h =
		Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
		Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;

	return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function pointOf(p: InboxPhoto): { lat: number; lng: number } | null {
	return p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
}

/** Photographs into meals, newest meal first, each in the order it was eaten. */
export function groupMeals(photos: InboxPhoto[]): Meal[] {
	const meals: Meal[] = [];

	for (const p of [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
		const meal = meals.at(-1);
		const here = pointOf(p);

		if (meal) {
			const gap = Date.parse(`${p.takenAt}Z`) - Date.parse(`${meal.photos[meal.photos.length - 1].takenAt}Z`);
			const near = !here || !meal.point || meters(here, meal.point) <= MEAL_SPAN_M;

			if (gap <= MEAL_GAP_MS && near) {
				meal.photos.push(p);
				meal.point ??= here;
				continue;
			}
		}

		// A meal that runs past midnight belongs to the day it started.
		meals.push({ day: p.takenAt.slice(0, 10), photos: [p], point: here });
	}

	return meals.reverse();
}

/**
 * A lat/lng box around a point, for the two range filters the gazetteer can
 * answer with an index.
 */
export function boxAround(p: { lat: number; lng: number }, radius: number) {
	const dLat = radius / 111_320;
	const dLng = radius / (111_320 * Math.max(0.01, Math.cos(rad(p.lat))));

	return { south: p.lat - dLat, north: p.lat + dLat, west: p.lng - dLng, east: p.lng + dLng };
}
