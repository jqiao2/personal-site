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
/**
 * The other half of the trip, and the reason a plus code can now say more than
 * a point.
 *
 * A plus code decodes to coordinates by ARITHMETIC — no network, no lookup —
 * and that is where it used to stop: a restaurant placed by plus code got a pin
 * and no neighbourhood, no borough, no city, nothing. Reverse-geocoding the
 * decoded point is what fills the hierarchy in, and it is the same trip for a
 * pasted coordinate pair or a point read out of a share link.
 */
const REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

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
	/**
	 * OSM's own identity for the matched object — "node", "way", "relation" and
	 * its id. This is what makes a stored geocode auditable rather than a
	 * rumour: with it the object can be re-queried years later, noticed to have
	 * moved or closed, and attributed as ODbL asks. Null when the answer did not
	 * come from an OSM object.
	 */
	osmType: string | null;
	osmId: number | null;
	/** The grade `precise` is computed from. Kept so the judgement can be re-made. */
	placeRank: number | null;
	houseNumber: string | null;
	road: string | null;
	neighborhood: string | null;
	/** OSM's `quarter`. Its own field — never a fallback for the neighbourhood. */
	quarter: string | null;
	/** OSM's `city_district`: Brooklyn, not New York. Null nearly everywhere else. */
	borough: string | null;
	city: string | null;
	stateRegion: string | null;
	/** ISO-3166-1 alpha-2, upper-cased — the shape `restaurants.country` wants. */
	country: string | null;
	/** OSM's own classification, humanised: "restaurant", "fast food", "cafe"… */
	kind: string | null;
	/**
	 * The cuisines OSM records, title-cased — "Vietnamese", "Sandwich".
	 *
	 * Free with the lookup and exactly the field the composer is asking you to
	 * fill in next, so there is no reason to make you type it again. OSM stores
	 * them semicolon-separated and lower-cased with underscores; they come out
	 * of here in the shape `restaurants.cuisines` wants.
	 */
	cuisines: string[];
	/** "83 Elizabeth Street, Chinatown, New York" — short enough to read in a row. */
	address: string;
	/**
	 * Whether lat/lng is THE RESTAURANT, or merely the middle of an area.
	 *
	 * This is the difference between a pin on a door and a pin floating in the
	 * centre of Sunset Park, and only the first is worth putting on a map. OSM
	 * grades every result with a `place_rank`: an actual object at a point — a
	 * restaurant node, a building, a house number — is 30, while a
	 * neighbourhood is 24, a city lower still. So 30 is the line, and anything
	 * under it is an area whose centroid must never be stored as a location.
	 *
	 * The neighbourhood is still read off these results, because that is what
	 * it is for: categorising a place, not locating it. The two come from
	 * different parts of the same answer — the point from the object, the
	 * neighbourhood from its address — and only the point has to be exact.
	 */
	precise: boolean;
}

/** Below this, a result is an area and its coordinates are a centroid. */
const PRECISE_PLACE_RANK = 30;

interface NominatimRow {
	name?: string;
	display_name?: string;
	lat: string;
	lon: string;
	type?: string;
	category?: string;
	addresstype?: string;
	place_rank?: number;
	/** "node" | "way" | "relation" — declared now, so it stops being dropped here. */
	osm_type?: string;
	osm_id?: number;
	address?: Record<string, string>;
	extratags?: Record<string, string> | null;
}

/** The three OSM object types; anything else is not one and is not stored. */
const OSM_TYPES = new Set(['node', 'way', 'relation']);

/** "fast_food" → "fast food", "vietnamese" → "Vietnamese". */
function humanise(value: string): string {
	return value.trim().replace(/_/g, ' ');
}

function titleCase(value: string): string {
	const v = humanise(value);
	return v ? v[0].toUpperCase() + v.slice(1) : v;
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
	// The cuisine lives in extratags, and it is the next field the composer
	// would otherwise ask you to type by hand.
	url.searchParams.set('extratags', '1');
	url.searchParams.set('limit', String(Math.min(10, Math.max(1, limit))));

	try {
		await pace();
		const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
		if (!res.ok) return [];
		const rows = (await res.json()) as NominatimRow[];
		// Exact points first. A neighbourhood that happens to share a name with
		// the restaurant you meant should never be the first thing offered.
		return rows
			.map(toHit)
			.sort((a, b) => Number(b.precise) - Number(a.precise));
	} catch {
		return [];
	}
}

/**
 * OSM's address object, split into the tiers this log stores.
 *
 * ONE KEY, ONE FIELD. The rule that matters here is that fallbacks run WITHIN a
 * tier and never ACROSS one. `town` really is the city of a town, and `province`
 * really is the state of a province, so those chains are honest. What used to
 * happen — `neighbourhood ?? suburb ?? quarter` — was a chain across three
 * different levels, and it destroyed information: a quarter came out labelled a
 * neighbourhood with no way to tell it back apart, and the borough was lost
 * entirely because `city_district` was never read at all while `a.city` for
 * anywhere in the five boroughs is "New York".
 *
 * `suburb` IS THE BOROUGH IN NEW YORK, and this is the one rule here that was
 * arrived at by asking Nominatim rather than by reading its documentation. The
 * expected key for a borough is `city_district`; what actually comes back for a
 * Sunset Park address is
 *
 *   { neighbourhood: "Sunset Park", suburb: "Brooklyn", city: "New York" }
 *
 * — no `city_district` at all. So `suburb` carries the borough here, while
 * elsewhere in the world it is routinely the neighbourhood and nothing coarser.
 *
 * The rule that fits both without guessing at the city: the two keys are two
 * TIERS, finest first. When `neighbourhood` and `suburb` both appear they are
 * different levels, so the first is the neighbourhood and the second is the
 * borough. When only `suburb` appears there is no second tier to fill, and it
 * is the neighbourhood — which is the reading everywhere outside a handful of
 * boroughed cities. `city_district` is still honoured first where a mapper did
 * use it.
 *
 * `county` is deliberately absent from every chain. It is not a city and not a
 * borough — the same point above reports "Kings County", which is a real fact
 * about Brooklyn and not a thing this log has a field for.
 */
export function splitAddress(a: Record<string, string>) {
	const fine = a.neighbourhood ?? null;
	const coarse = a.suburb ?? null;
	return {
		houseNumber: a.house_number ?? null,
		road: a.road ?? a.pedestrian ?? a.footway ?? null,
		// Only when both tiers are present does the coarser become the borough.
		neighborhood: fine ?? coarse,
		quarter: a.quarter ?? null,
		borough: a.city_district ?? a.borough ?? (fine && coarse ? coarse : null),
		city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
		stateRegion: a.state ?? a.province ?? a.region ?? null,
		country: a.country_code ? a.country_code.toUpperCase() : null,
	};
}

/** "83 Elizabeth Street, Chinatown, Manhattan" — short enough to read in a row. */
function streetLine(
	parts: { houseNumber: string | null; road: string | null },
	...tail: (string | null)[]
): string {
	const street = [parts.houseNumber, parts.road].filter(Boolean).join(' ');
	return [street, ...tail].filter(Boolean).join(', ');
}

function toHit(row: NominatimRow): GeocodeHit {
	const a = row.address ?? {};
	const parts = splitAddress(a);
	const { neighborhood, city } = parts;

	return {
		name: row.name || (row.display_name ?? '').split(',')[0] || '',
		display: row.display_name ?? '',
		lat: Number(row.lat),
		lng: Number(row.lon),
		osmType: row.osm_type && OSM_TYPES.has(row.osm_type) ? row.osm_type : null,
		osmId: Number.isFinite(row.osm_id) ? (row.osm_id as number) : null,
		placeRank: Number.isFinite(row.place_rank) ? (row.place_rank as number) : null,
		...parts,
		kind: row.type ? humanise(row.type) : null,
		cuisines: (row.extratags?.cuisine ?? '')
			.split(';')
			.map((c) => titleCase(c))
			.filter(Boolean),
		address: streetLine(parts, neighborhood, parts.borough ?? city),
		// `boundary` results are administrative outlines and carry a rank of 30
		// at street level, so rank alone would let one through.
		precise: (row.place_rank ?? 0) >= PRECISE_PLACE_RANK && row.category !== 'boundary',
	};
}

/**
 * What is at this point — the trip a plus code could not previously make.
 *
 * A plus code, a pasted coordinate pair and a point scraped out of a share link
 * all arrive as two numbers and nothing else, and two numbers put a pin on a
 * map without saying what neighbourhood, borough or city the pin is in. This
 * asks OSM that question directly.
 *
 * It shares `pace()` with the forward lookup on purpose: Nominatim's
 * one-request-a-second budget is per SERVICE, not per endpoint, and two
 * independently-paced callers would quietly spend twice the allowance under
 * this site's name.
 *
 * `zoom=18` is building level — the granularity at which the address object
 * carries a house number and a road. Asking for less returns a street or a
 * suburb, and the street half comes back empty.
 *
 * Returns null rather than throwing, for the same reason `geocode` returns []:
 * a geocoder being down must not stop you saving a place, it only means the
 * words are not filled in for you.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeHit | null> {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

	const url = new URL(REVERSE_ENDPOINT);
	url.searchParams.set('lat', String(lat));
	url.searchParams.set('lon', String(lng));
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('addressdetails', '1');
	url.searchParams.set('extratags', '1');
	url.searchParams.set('zoom', '18');

	try {
		await pace();
		const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
		if (!res.ok) return null;
		const row = (await res.json()) as NominatimRow & { error?: string };
		// Nominatim answers 200 with an `error` body for a point in the ocean.
		if (row.error || !row.lat) return null;

		const hit = toHit(row);
		// THE POINT WE ASKED ABOUT, NOT THE ONE IT ANSWERED WITH. Reverse
		// geocoding returns the matched OBJECT's coordinates — the centre of the
		// building, or of the street, which can sit tens of metres from the door
		// that was actually pinned. The caller already has the point it wants;
		// what it came here for is the words.
		return { ...hit, lat, lng };
	} catch {
		return null;
	}
}
