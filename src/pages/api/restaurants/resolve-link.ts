import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// GET /api/restaurants/resolve-link?url=…  (owner only)
//
// Reads a map link for its coordinates, or failing that for the address it
// names.
//
// The by-hand form in the place dialog offers "paste a link or a pair of
// coordinates", and a pair of coordinates needs no server. A link often does:
// the share sheet on a phone produces `maps.app.goo.gl/xxxx`, which carries no
// coordinates at all until it is followed, and a browser cannot follow it —
// cross-origin, and the response is not readable even when it arrives. So the
// redirect is followed here, and the long URL it lands on is scanned for the
// same patterns the client already knows how to read.
//
// WHAT A SHARE LINK ACTUALLY CONTAINS, WHICH IS NOT WHAT YOU WOULD HOPE. A
// `maps.app.goo.gl` link redirects to a `google.com/maps?q=…&ftid=…` URL whose
// query is the place's NAME AND STREET ADDRESS, with no coordinates anywhere:
// the point only exists once Google's own JavaScript has run. So the honest
// answer for those is the address, handed back for the form to show — and a
// street address is not a point, which is why the dialog offers a plus code
// beside this and says which of the two will actually place the restaurant.
//
// It is owner-gated for the same reason the geocoder is: it makes this server
// fetch a URL somebody else chose, and only the owner has any reason to ask.
// The scheme check and the reply shape are the rest of that fence — two
// numbers and one line of address, never the page.

/** The place's name and address, as the share link's `q` parameter. */
function addressIn(url: string): string | null {
	try {
		const q = new URL(url).searchParams.get('q');
		if (!q) return null;
		const text = q.trim();
		// A `q` that is itself a coordinate pair is a point, not an address, and
		// the caller has already read it as one.
		if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(text)) return null;
		return text.length > 200 ? null : text;
	} catch {
		return null;
	}
}

/** Where Google hides a point in a long maps URL, most reliable first. */
const PATTERNS = [
	/@(-?\d+\.\d+),(-?\d+\.\d+)/,
	/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
	/[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
	/[?&]ll=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
	/\/(-?\d+\.\d+),(-?\d+\.\d+)/,
];

function coordsIn(text: string): { lat: number; lng: number } | null {
	for (const re of PATTERNS) {
		const m = text.match(re);
		if (!m) continue;
		const lat = Number(m[1]);
		const lng = Number(m[2]);
		if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
			return { lat, lng };
		}
	}
	return null;
}

export const GET: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const raw = url.searchParams.get('url') ?? '';
	let target: URL;
	try {
		target = new URL(raw);
	} catch {
		return apiError('not a URL', 400);
	}
	if (target.protocol !== 'https:' && target.protocol !== 'http:') {
		return apiError('only http(s) links can be followed', 400);
	}

	// The link as pasted may already carry the point, in which case there is no
	// reason to fetch anything.
	const direct = coordsIn(raw);
	if (direct) return json({ ...direct, address: null });

	try {
		// HEAD first: a short link answers with a Location header and no body,
		// which is the whole of what this needs. Some hosts refuse HEAD, so a
		// GET is the fallback — still only the final URL is read, never the page.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 6000);
		let res: Response;
		try {
			res = await fetch(target, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
			if (!res.ok) res = await fetch(target, { redirect: 'follow', signal: controller.signal });
		} finally {
			clearTimeout(timeout);
		}
		const found = coordsIn(res.url);
		if (found) return json({ ...found, address: null });
		return json({ lat: null, lng: null, address: addressIn(res.url) });
	} catch {
		// A link that cannot be followed is not an error worth a 500: the form
		// says so and the by-hand words are still there to save.
		return json({ lat: null, lng: null, address: null });
	}
};
