// Turning "Wu's Wonton King" into a point on the map.
//
// WHY NOT MAPTILER, WHOSE KEY WE ALREADY HAVE. Because it cannot do this. Its
// geocoder is an address and place index with no POI layer: "Wu's Wonton King"
// returns villages in Spain, "Katz's Delicatessen New York" returns Katz Pond,
// and a proximity bias toward New York changes nothing. It is excellent at
// "165 East Broadway, Manhattan" and at neighbourhood names — just not at the
// thing this section is made of, which is restaurants called by their names.
//
// Nominatim reads OpenStreetMap, where restaurants are first-class objects with
// names, so it finds all of the above at the right coordinates. It is also the
// "open geocode" the brief asked for, and needs no key.
//
// THE POLICY IS THE REASON THIS IS SERVER-SIDE. Nominatim asks for a real
// identifying User-Agent and no more than one request a second, and it is a
// volunteer-run service, so honouring that is the rent. A browser cannot set a
// User-Agent, and a debounced field in a browser cannot be rate-limited across
// tabs — so the lookup goes through our own route, which sets the header and
// paces the calls in one place.
//
// THE RESULT IS A SUGGESTION, NOT AN ANSWER. OSM's idea of a neighbourhood is
// its own: Ba Xuyên comes back as "Dyker Heights" when anyone who lives there
// would say Sunset Park, and Katz's lands in "Manhattan Community Board 3".
// That is why the composer keeps every field editable after a pick — the brief
// asked for a geocode "that I confirm by hand", and this is the half that needs
// confirming.

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Sent on every request, as Nominatim's usage policy requires. */
const USER_AGENT = 'jasonqiao.com restaurant log (https://jasonqiao.com)';

/** One request a second, shared by every caller in this process. */
const MIN_INTERVAL_MS = 1100;
let lastCallAt = 0;

async function pace(): Promise<void> {
	const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastCallAt = Date.now();
}

export interface GeocodeHit {
	/** The place's own name, when OSM has one — "Wu's Wonton King". */
	name: string;
	/** The full line Nominatim renders, for disambiguating two similar hits. */
	display: string;
	lat: number;
	lng: number;
	neighborhood: string | null;
	city: string | null;
	stateRegion: string | null;
	/** ISO-3166-1 alpha-2, upper-cased — the shape `restaurants.country` wants. */
	country: string | null;
	/** OSM's own classification: "restaurant", "fast_food", "cafe", "address"… */
	kind: string | null;
}

interface NominatimRow {
	name?: string;
	display_name?: string;
	lat: string;
	lon: string;
	type?: string;
	address?: Record<string, string>;
}

/**
 * Look `query` up, best match first.
 *
 * Returns [] rather than throwing when the lookup fails: a geocoder being down
 * must not stop you adding a place, it just means you add it without a point.
 */
export async function geocode(query: string, limit = 5): Promise<GeocodeHit[]> {
	const q = query.trim();
	if (q.length < 3) return [];

	const url = new URL(ENDPOINT);
	url.searchParams.set('q', q);
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('addressdetails', '1');
	url.searchParams.set('limit', String(Math.min(10, Math.max(1, limit))));

	try {
		await pace();
		const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
		if (!res.ok) return [];
		const rows = (await res.json()) as NominatimRow[];
		return rows.map(toHit);
	} catch {
		return [];
	}
}

function toHit(row: NominatimRow): GeocodeHit {
	const a = row.address ?? {};
	// OSM spreads "the city" across half a dozen keys depending on how the
	// country is administered, and the neighbourhood across three. Take the
	// first that exists, most specific first.
	const neighborhood = a.neighbourhood ?? a.suburb ?? a.quarter ?? null;
	const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null;
	const stateRegion = a.state ?? a.province ?? a.region ?? null;

	return {
		name: row.name || (row.display_name ?? '').split(',')[0] || '',
		display: row.display_name ?? '',
		lat: Number(row.lat),
		lng: Number(row.lon),
		neighborhood,
		city,
		stateRegion,
		country: a.country_code ? a.country_code.toUpperCase() : null,
		kind: row.type ?? null,
	};
}
