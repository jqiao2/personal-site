import { supabasePublic } from './supabase';

/** One venue on the theater map: how many viewings it had in scope. */
export type TheaterSpot = { name: string; lat: number; lng: number; n: number };

type Row = {
	watched_date: string | null;
	theaters: { name: string; lat: number | null; lng: number | null } | null;
};

/**
 * Theater viewings grouped by venue, for a calendar year (by watch date) or all
 * time. Venues with no coordinates yet are counted in `unplaced`, not dropped
 * silently. Duplicate theater rows for one venue share coordinates, so they are
 * merged on lat/lng.
 */
export async function loadTheaterSpots(scope: number | 'all'): Promise<{ spots: TheaterSpot[]; unplaced: number }> {
	let q = supabasePublic
		.from('logs')
		.select('watched_date, theaters!inner(name, lat, lng)')
		.eq('medium', 'theater')
		.is('deleted_at', null);

	if (scope !== 'all') q = q.gte('watched_date', `${scope}-01-01`).lte('watched_date', `${scope}-12-31`);

	// ponytail: one page; a few hundred theater trips a year is far under the 1,000-row cap.
	const { data, error } = await q.overrideTypes<Row[], { merge: false }>();

	if (error) throw new Error(`loadTheaterSpots failed: ${error.message}`);

	const byPlace = new Map<string, TheaterSpot>();
	let unplaced = 0;

	for (const r of data) {
		const t = r.theaters;

		if (t?.lat == null || t.lng == null) {
			unplaced++;
			continue;
		}

		const key = `${t.lat},${t.lng}`;
		const spot = byPlace.get(key) ?? { name: t.name.replace(/,.*$/, ''), lat: t.lat, lng: t.lng, n: 0 };

		spot.n++;
		byPlace.set(key, spot);
	}

	return { spots: [...byPlace.values()].sort((a, b) => b.n - a.n), unplaced };
}
