// What the map is given.
//
// The projection, framing and clustering that used to live here are MapLibre's
// now (see src/components/RestaurantMap.astro and src/lib/map-style.ts) — it
// does fitBounds and GeoJSON clustering natively, and doing them by hand
// alongside it would have been two answers to one question. What survives is
// the shape of a point and the reasoning about what goes on one, because that
// is a decision about this section rather than about a renderer.
//
// THE PIN CARRIES THE VERDICT, and only the verdict. Of the three rating
// signals a visit can hold, it is the one that answers the question a map is
// asked — I am standing here, would I go back in? Stars would need a number
// rendered at 12px and the heart would collapse a hundred places into two
// states, so both stay behind on the list and the entry.
//
// WHAT HAPPENS ON FIRST LOAD is settled here rather than in the component that
// obeys it: the map frames the city holding the most of the collection, never
// the bounds of everything. Four fifths of these pins are one dense New York
// cluster and the rest are scattered across Mexico City, Austin, LA and Tokyo,
// so fit-to-bounds is a world map with five specks on it — and defaulting to
// New York would silently hide a fifth of the collection instead. The city
// panel beside the map carries the rest, ordered by how much each holds, so
// what is off the edge is legible before you click anything.

/**
 * Collapse marks that would overlap, in SCREEN space.
 *
 * MapLibre can cluster a GeoJSON source itself, and this used its own
 * clustering first — but reading the result back needs querySourceFeatures,
 * which only returns what is in a loaded tile, so a stalled or failed tile
 * pipeline silently produced zero markers. The pins are the content; they can
 * not be downstream of the basemap's health. Clustering here instead means the
 * marks are computed from the projected coordinates alone and come up whether
 * or not a single tile ever arrives.
 *
 * It also costs nothing at this size: a personal log is a few hundred points,
 * re-clustered on a pointer move, which is far cheaper than the tile decode
 * happening beside it.
 *
 * `radius` is in pixels, because that is the unit the problem is actually in —
 * twelve restaurants on eight blocks overlap at a given zoom, not at a given
 * distance.
 */
export interface Clusterable {
	x: number;
	y: number;
	verdict: number | null;
}

export interface ScreenCluster<T> {
	x: number;
	y: number;
	members: T[];
}

export function clusterByScreen<T extends Clusterable>(
	marks: T[],
	radius = 34,
): { loose: T[]; clusters: ScreenCluster<T>[] } {
	const taken = new Set<number>();
	const loose: T[] = [];
	const clusters: ScreenCluster<T>[] = [];

	for (let i = 0; i < marks.length; i++) {
		if (taken.has(i)) continue;
		const group = [marks[i]];
		taken.add(i);
		for (let j = i + 1; j < marks.length; j++) {
			if (taken.has(j)) continue;
			if (Math.hypot(marks[j].x - marks[i].x, marks[j].y - marks[i].y) <= radius) {
				group.push(marks[j]);
				taken.add(j);
			}
		}
		if (group.length === 1) {
			loose.push(group[0]);
			continue;
		}
		clusters.push({
			x: group.reduce((s, g) => s + g.x, 0) / group.length,
			y: group.reduce((s, g) => s + g.y, 0) / group.length,
			members: group,
		});
	}
	return { loose, clusters };
}

/** The verdict mix of a cluster, as counts per band, for the badge's strip. */
export function verdictMix(members: Clusterable[]): { good: number; mid: number; bad: number } {
	let good = 0;
	let mid = 0;
	let bad = 0;
	for (const m of members) {
		if (m.verdict == null) continue;
		if (m.verdict <= 1) good++;
		else if (m.verdict <= 3) mid++;
		else bad++;
	}
	return { good, mid, bad };
}

export interface MapPoint {
	id: number;
	name: string;
	lat: number;
	lng: number;
	/** Null for a place on the to-try list; its pin is drawn as an open ring. */
	verdict: number | null;
	/** A place you've been, or one you mean to go to. Drawn differently. */
	visited: boolean;
	price: string | null;
	cuisine: string;
	/** The city, matched exactly by the switcher and by the framing. */
	city: string;
	/** "Sunset Park, Brooklyn" — what the popup shows. */
	where: string;
	rating: number | null;
	visits: number;
	hearted: boolean;
}
