// Searching the places we have imported, rather than asking the internet.
//
// See supabase/migrations/0032_place_sources.sql for why the gazetteer exists.
// This is the read side: what the composer calls while you type.
//
// EVERY ANSWER CARRIES ITS SOURCE, and that is not decoration. The suggestions
// in these dialogs come from four bodies with four different ideas of what is
// true: the health department knows every permitted kitchen in the five
// boroughs and calls one of them "SABOR LATINO SPANISH AMERICAN"; Overture and
// Foursquare know the name on the awning; OpenStreetMap knows whichever the
// last mapper typed. When two of them disagree — and on a Chinatown noodle shop
// they usually do — the only way to choose is to know who is speaking. So the
// source rides on the row and is shown on the row.
import { supabasePublic } from './supabase';

/** The datasets a suggestion can come from, and what to call them on screen. */
export const SOURCE_LABELS = {
	dohmh: 'NYC health dept',
	overture: 'Overture',
	foursquare: 'Foursquare',
	osm: 'OpenStreetMap',
	/** Not a dataset: a place already in the log. */
	log: 'already logged',
} as const;

export type SourceKey = keyof typeof SOURCE_LABELS;

export interface GazetteerHit {
	id: number;
	source: SourceKey;
	sourceLabel: string;
	name: string;
	lat: number;
	lng: number;
	address: string | null;
	locality: string | null;
	city: string | null;
	region: string | null;
	country: string | null;
	cuisines: string[];
	phone: string | null;
	website: string | null;
	/** Metres from the reference point, when one was given. */
	distance: number | null;
}

/**
 * The same normalisation the imported names were stored under.
 *
 * It exists in three places — here, the importer, and `place_norm()` in the
 * database — and all three have to agree or a search finds nothing. The
 * database function is the one that matters; these two are for building queries
 * without a round trip.
 */
export function normalise(raw: string): string {
	return raw
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim();
}

const EARTH_M = 6371000;

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(bLat - aLat);
	const dLng = toRad(bLng - aLng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

export interface GazetteerQuery {
	q: string;
	/** Rank by closeness to here, when the caller knows roughly where it is. */
	near?: { lat: number; lng: number } | null;
	limit?: number;
}

/**
 * Places matching `q`, best first.
 *
 * FETCH WIDE, RANK HERE. The database can find the rows — a trigram index over
 * thirty thousand names answers in milliseconds — but "best" is a judgement
 * involving three things it would take a stored procedure to express: whether
 * the match is at the start of the name, how far away it is, and which source
 * said so. Sixty candidates is a small enough net to sort in memory and a wide
 * enough one that the right answer is in it.
 */
export async function searchGazetteer(query: GazetteerQuery): Promise<GazetteerHit[]> {
	const norm = normalise(query.q);
	if (norm.length < 2) return [];

	const { data, error } = await supabasePublic
		.from('place_sources')
		.select('id,source,name,lat,lng,address,locality,city,region,country,cuisines,phone,website')
		.ilike('name_norm', `%${norm}%`)
		.limit(60);
	if (error) throw new Error(error.message);

	const rows = (data ?? []) as Omit<GazetteerHit, 'sourceLabel' | 'distance'>[];
	const near = query.near ?? null;

	return rows
		.map((r) => ({
			...r,
			sourceLabel: SOURCE_LABELS[r.source] ?? r.source,
			distance: near ? metres(near.lat, near.lng, r.lat, r.lng) : null,
		}))
		.sort((a, b) => {
			// A name that STARTS with what you typed is what you meant; "Thai
			// Villa" should not sit under "Original Thai Villa Express" because
			// the latter happens to be nearer.
			const aStarts = normalise(a.name).startsWith(norm);
			const bStarts = normalise(b.name).startsWith(norm);
			if (aStarts !== bStarts) return aStarts ? -1 : 1;
			if (a.distance != null && b.distance != null && a.distance !== b.distance) {
				return a.distance - b.distance;
			}
			// Failing both, the shorter name is the more likely subject: it is
			// the restaurant rather than the restaurant's third franchise.
			return a.name.length - b.name.length || a.name.localeCompare(b.name, 'en');
		})
		.slice(0, query.limit ?? 8);
}

/** What the composer stores when a suggestion is accepted. */
export function toPlaceFields(hit: GazetteerHit) {
	return {
		name: hit.name,
		neighborhood: hit.locality,
		city: hit.city ?? 'New York',
		stateRegion: hit.region,
		country: hit.country ?? 'US',
		lat: hit.lat,
		lng: hit.lng,
		cuisines: hit.cuisines,
		websiteUrl: hit.website,
	};
}
