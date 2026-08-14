// The candidate list behind every "what place is this?" field, in one place.
//
// Three fields ask that question — the to-try composer, the log-a-meal
// composer and the Place it dialog — and all three want the same answer: our
// own imported copies first, the live geocoder behind them, merged into one
// list with the source named on every row. It was written out three times
// before this module existed, and the copies had already drifted: one of them
// silently took the top hit rather than offering the list.
//
// OUR OWN COPIES FIRST, and not only because they are faster. The imported
// gazetteer has the places this city is actually made of — every permitted
// kitchen in the five boroughs — where the live geocoder has whatever a mapper
// got round to. The geocoder still runs, because it knows everywhere that is
// not New York.
//
// THIS RUNS IN THE BROWSER. Both routes it calls are owner-gated and paced
// server-side, which is the whole reason the lookup goes through them rather
// than at Nominatim directly.

export interface GeoHit {
	/** Which body said so. Absent means the live geocoder. */
	source?: string;
	sourceLabel?: string;
	name: string;
	display: string;
	lat: number;
	lng: number;
	neighborhood: string | null;
	city: string | null;
	stateRegion: string | null;
	country: string | null;
	kind: string | null;
	cuisines: string[];
	address: string;
	/** True only when lat/lng is the place itself, not the middle of an area. */
	precise: boolean;
}

export interface PlaceLookup {
	hits: GeoHit[];
	/**
	 * Whether anything answered at all.
	 *
	 * "Nothing was found" and "nobody replied" are different sentences and want
	 * different words on screen, which is why this is reported separately from
	 * an empty list. Callers that treat both the same — the composers, where an
	 * unplaced entry is a perfectly good outcome — can ignore it.
	 */
	reachable: boolean;
}

/**
 * Look a restaurant up by NAME, not by address — you know what a place is
 * called, and you are usually adding it because someone said the name out
 * loud. `hint` is whatever the form knows about where it is; it is appended to
 * the geocoder's query, which is what separates the four Tacos El Bronco from
 * each other. The gazetteer searches on the name alone, because it is already
 * ranked and the hint is prose.
 */
export async function lookupPlaces(name: string, hint = ''): Promise<PlaceLookup> {
	const q = hint ? `${name}, ${hint}` : name;
	let reachable = true;
	try {
		const [local, geo] = await Promise.all([
			fetch(`/api/restaurants/gazetteer?q=${encodeURIComponent(name)}`)
				.then((r) => (r.ok ? r.json() : { hits: [] }))
				.catch(() => ({ hits: [] })),
			fetch(`/api/restaurants/geocode?q=${encodeURIComponent(q)}`)
				.then((r) => (r.ok ? r : Promise.reject(new Error(String(r.status)))))
				.then((r) => r.json())
				.catch((e: unknown) => {
					// A 502 is our own route reporting that Nominatim was asked and
					// gave nothing usable back — the site is up, the answer is empty.
					// Anything else is the route itself not answering.
					if (String((e as Error).message) !== '502') reachable = false;
					return { hits: [] };
				}),
		]);

		const mine: GeoHit[] = ((local.hits ?? []) as Record<string, unknown>[]).map((h) => ({
			source: h.source as string,
			sourceLabel: h.sourceLabel as string,
			name: h.name as string,
			display: [h.name, h.address, h.locality].filter(Boolean).join(', '),
			lat: h.lat as number,
			lng: h.lng as number,
			neighborhood: (h.locality as string) ?? null,
			city: (h.city as string) ?? null,
			stateRegion: (h.region as string) ?? null,
			country: (h.country as string) ?? null,
			kind: null,
			cuisines: (h.cuisines as string[]) ?? [],
			address: (h.address as string) ?? '',
			// An imported row is a point on a building, which is the thing
			// `precise` exists to distinguish.
			precise: true,
		}));
		const osm: GeoHit[] = ((geo.hits ?? []) as GeoHit[]).map((h) => ({
			...h,
			source: 'osm',
			sourceLabel: 'OpenStreetMap',
		}));

		// Our own copies answering at all is proof enough that the lookup worked,
		// whatever the geocoder did.
		if (mine.length > 0) reachable = true;
		// Same place from two sources is one row: ours wins, because it is the
		// one with the health department's geocode on it.
		const seen = new Set(mine.map((h) => h.name.toLowerCase()));
		return { hits: [...mine, ...osm.filter((h) => !seen.has(h.name.toLowerCase()))], reachable };
	} catch {
		return { hits: [], reachable: false };
	}
}

/** "Sunset Park, Brooklyn" — the words a hit contributes to a location line. */
export function hitWhere(hit: GeoHit): string {
	return [hit.neighborhood, hit.city].filter(Boolean).join(', ');
}
