// GPX and TCX decoding — ACTIVITIES.md §4's `gpx.ts` / `tcx.ts`, kept in one
// file because they are the same job twice: pull an ordered list of
// trackpoints out of XML.
//
// WHY NO XML PARSER DEPENDENCY. These two formats are read here for exactly
// one purpose — the trackpoints — and both write them as a flat, regular,
// machine-generated sequence of elements with no attributes worth speaking of,
// no namespacing games and no mixed content. A scan for `<trkpt>` blocks
// answers the whole question in forty lines. Pulling in an XML tree builder to
// then walk it to the same leaves would be more code, more supply chain, and
// slower over 450 files.
//
// ponytail: regex-scanned XML, not a parser. Holds because these are
// Strava's own machine-written exports, which are uniform by construction. If
// a hand-edited or third-party GPX ever has to be read, swap in a real parser
// rather than adding special cases here — that is the upgrade path, and the
// point at which this shortcut stops being honest.
//
// Neither format carries a summary: no total distance, no average power, no
// elapsed time. Everything the schema wants is DERIVED from the points here,
// which is also why these activities score lower on §3's cascade — a 2016 GPX
// with no heart rate reaches the MET floor and says so.

import { haversine } from './../route-shape';
import type { CanonicalActivity, CanonicalStreams } from './canonical';
import { sportFromXmlType, UnknownSportError } from './canonical';
import type { Sport } from './../sports';

export interface XmlParseOptions {
	/** What the sport is when something outside the file already knows it —
	 *  activities.csv during an archive import, or a --sport override. Left out,
	 *  the file speaks for itself: a single-activity download from Strava carries
	 *  its own type. */
	sport?: Sport;
}

interface Point {
	lat: number;
	lng: number;
	time: number | null;
	ele: number | null;
	hr: number | null;
	cad: number | null;
	power: number | null;
	dist: number | null;
	speed: number | null;
}

// ---------------------------------------------------------------------------
// GPX
// ---------------------------------------------------------------------------

const TRKPT = /<trkpt\b[^>]*\blat="([-\d.]+)"[^>]*\blon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
// Self-closing trackpoints (position only, no children) appear in older files.
const TRKPT_BARE = /<trkpt\b[^>]*\blat="([-\d.]+)"[^>]*\blon="([-\d.]+)"[^>]*\/>/g;

export function parseGpx(xml: string, opts: XmlParseOptions): CanonicalActivity | null {
	const points: Point[] = [];

	for (const m of xml.matchAll(TRKPT)) {
		const body = m[3];
		points.push({
			lat: Number(m[1]),
			lng: Number(m[2]),
			time: tagTime(body, 'time'),
			ele: tagNum(body, 'ele'),
			// Strava writes these into the TrackPointExtension namespace; the
			// prefix varies by writer (`gpxtpx:hr`, `ns3:hr`), so match the
			// local name and ignore whatever prefix it arrived with.
			hr: tagNum(body, 'hr'),
			cad: tagNum(body, 'cad'),
			power: tagNum(body, 'power') ?? tagNum(body, 'watts'),
			dist: null,
			speed: null,
		});
	}
	if (points.length === 0) {
		for (const m of xml.matchAll(TRKPT_BARE)) {
			points.push({ lat: Number(m[1]), lng: Number(m[2]), time: null, ele: null, hr: null, cad: null, power: null, dist: null, speed: null });
		}
	}
	if (points.length === 0) return null;

	const name = firstTag(xml, 'name');
	return fromPoints(points, opts.sport ?? xmlSport(firstTag(xml, 'type')), name);
}

// ---------------------------------------------------------------------------
// TCX
// ---------------------------------------------------------------------------

const TRACKPOINT = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/g;

export function parseTcx(xml: string, opts: XmlParseOptions): CanonicalActivity | null {
	const points: Point[] = [];

	for (const m of xml.matchAll(TRACKPOINT)) {
		const body = m[1];
		const lat = tagNum(body, 'LatitudeDegrees');
		const lng = tagNum(body, 'LongitudeDegrees');
		points.push({
			// TCX keeps recording through a GPS dropout, writing a Trackpoint
			// with heart rate and no position. Those samples are real data for
			// §3 and are kept — the route just skips them (see canonical.ts,
			// which filters non-finite pairs out of the track).
			lat: lat ?? NaN,
			lng: lng ?? NaN,
			time: tagTime(body, 'Time'),
			ele: tagNum(body, 'AltitudeMeters'),
			// <HeartRateBpm><Value>142</Value></HeartRateBpm> — scoped to the
			// HeartRateBpm block, because <Value> is not unique inside a
			// Trackpoint (extensions use it too) and a bare match would happily
			// read a cadence or a running-dynamics figure as a heart rate.
			hr: tagNum(block(body, 'HeartRateBpm') ?? '', 'Value'),
			cad: tagNum(body, 'Cadence'),
			power: tagNum(body, 'Watts'),
			dist: tagNum(body, 'DistanceMeters'),
			speed: tagNum(body, 'Speed'),
		});
	}
	if (points.length === 0) return null;

	return fromPoints(points, opts.sport ?? xmlSport(sportAttr(xml)), null);
}

// ---------------------------------------------------------------------------
// Points → canonical
// ---------------------------------------------------------------------------

/**
 * Everything the schema wants, derived from the points, because neither format
 * carries a summary.
 *
 * Elevation gain is the sum of positive changes with a 3-metre threshold. The
 * threshold is the whole reason this isn't a one-liner: barometric and GPS
 * altitude both jitter by a metre or two at rest, and a naive sum turns a flat
 * ride into 400m of climbing. 3m is the convention Strava and Garmin both use.
 */
function fromPoints(points: Point[], sport: Sport, name: string | null): CanonicalActivity | null {
	const timed = points.filter((p) => p.time !== null);
	const t0 = timed.length ? timed[0].time! : null;
	const tEnd = timed.length ? timed[timed.length - 1].time! : null;

	const startedAt = t0 !== null ? new Date(t0).toISOString() : null;
	if (!startedAt) return null; // no clock at all — nothing here can be filed on a day

	const elapsed = tEnd !== null && t0 !== null ? Math.round((tEnd - t0) / 1000) : 0;

	// --- distance ----------------------------------------------------------
	// TCX often states it; GPX never does, so walk the track.
	let distance: number | null = null;
	const statedDist = points.map((p) => p.dist).filter((d): d is number => d !== null);
	if (statedDist.length) {
		distance = Math.max(...statedDist);
	} else {
		let sum = 0;
		let prev: [number, number] | null = null;
		for (const p of points) {
			if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
			const cur: [number, number] = [p.lat, p.lng];
			if (prev) sum += haversine(prev, cur);
			prev = cur;
		}
		distance = sum > 0 ? sum : null;
	}

	// --- elevation ---------------------------------------------------------
	let gain = 0;
	let loss = 0;
	let high = -Infinity;
	let low = Infinity;
	let anchor: number | null = null;
	for (const p of points) {
		if (p.ele === null || !Number.isFinite(p.ele)) continue;
		if (p.ele > high) high = p.ele;
		if (p.ele < low) low = p.ele;
		if (anchor === null) {
			anchor = p.ele;
			continue;
		}
		const delta = p.ele - anchor;
		if (delta >= 3) {
			gain += delta;
			anchor = p.ele;
		} else if (delta <= -3) {
			loss += -delta;
			anchor = p.ele;
		}
	}
	const hasEle = Number.isFinite(high);

	// --- moving time -------------------------------------------------------
	// Derived the same way as FIT's: a sample counts as moving when the athlete
	// covered ground since the previous one. Without this a ride with a café
	// stop reports its whole elapsed time as training stress (§3).
	let moving = 0;
	let prevMoving: Point | null = null;
	const movingFlags: boolean[] = [];
	for (const p of points) {
		if (!prevMoving || p.time === null || prevMoving.time === null) {
			movingFlags.push(true);
			prevMoving = p;
			continue;
		}
		const dt = (p.time - prevMoving.time) / 1000;
		const dm =
			Number.isFinite(p.lat) && Number.isFinite(prevMoving.lat)
				? haversine([prevMoving.lat, prevMoving.lng], [p.lat, p.lng])
				: 0;
		const isMoving = dt > 0 && dm / dt > 0.3;
		movingFlags.push(isMoving);
		if (isMoving && dt < 60) moving += dt;
		prevMoving = p;
	}

	// --- streams -----------------------------------------------------------
	const streams: CanonicalStreams = {};
	if (t0 !== null) streams.time_s = points.map((p) => (p.time === null ? 0 : Math.round((p.time - t0) / 1000)));
	if (points.some((p) => Number.isFinite(p.lat))) {
		streams.latlng = points.map((p) => [nullable(p.lat), nullable(p.lng)] as unknown as [number, number]);
	}
	if (hasEle) streams.altitude_m = points.map((p) => p.ele) as number[];
	if (points.some((p) => p.hr !== null)) streams.heartrate = points.map((p) => p.hr) as number[];
	if (points.some((p) => p.cad !== null)) streams.cadence = points.map((p) => p.cad) as number[];
	if (points.some((p) => p.power !== null)) streams.power_w = points.map((p) => p.power) as number[];
	if (points.some((p) => p.speed !== null)) streams.speed_ms = points.map((p) => p.speed) as number[];
	if (statedDist.length) streams.distance_m = points.map((p) => p.dist) as number[];
	streams.moving = movingFlags;

	const movingSeconds = moving > 0 ? Math.round(moving) : elapsed || null;

	return {
		sport,
		title: name,
		started_at: startedAt,
		elapsed_seconds: elapsed,
		moving_seconds: movingSeconds,
		distance_m: distance,
		elevation_gain_m: hasEle ? Number(gain.toFixed(1)) : null,
		elevation_loss_m: hasEle ? Number(loss.toFixed(1)) : null,
		elev_high_m: hasEle ? high : null,
		elev_low_m: hasEle ? low : null,
		avg_speed_ms: distance && movingSeconds ? distance / movingSeconds : null,
		avg_hr: average(points.map((p) => p.hr)),
		max_hr: maximum(points.map((p) => p.hr)),
		avg_cadence: average(points.map((p) => p.cad)),
		avg_power_w: average(points.map((p) => p.power)),
		max_power_w: maximum(points.map((p) => p.power)),
		streams,
	};
}

// ---------------------------------------------------------------------------
// Tiny XML readers
// ---------------------------------------------------------------------------

/** Matches `<hr>` and `<gpxtpx:hr>` alike — the prefix a writer chose for an
 *  extension namespace is not information we need. */
function tagRe(local: string): RegExp {
	return new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${local}>`);
}

/** The inner XML of the first `<Local>…</Local>`, for reading a child out of a
 *  known parent rather than out of the whole trackpoint. */
function block(xml: string, local: string): string | null {
	const m = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`).exec(xml);
	return m ? m[1] : null;
}

function tagNum(xml: string, local: string): number | null {
	const m = tagRe(local).exec(xml);
	if (!m) return null;
	const v = Number(m[1].trim());
	return Number.isFinite(v) ? v : null;
}

function tagTime(xml: string, local: string): number | null {
	const m = tagRe(local).exec(xml);
	if (!m) return null;
	const t = Date.parse(m[1].trim());
	return Number.isFinite(t) ? t : null;
}

/** The `<Activity Sport="Biking">` attribute a TCX opens with. */
function sportAttr(xml: string): string | null {
	return /<Activity[^>]*Sport="([^"]+)"/.exec(xml)?.[1] ?? null;
}

/**
 * A dropped file has to state its own sport, and this refuses to guess when it
 * does not. Falling back to `other` here would file a ride under a slug with a
 * generic MET value and no primary stats — permanently, and silently. Pass
 * `--sport` instead; the message says so.
 */
function xmlSport(type: string | null): Sport {
	const slug = sportFromXmlType(type);
	if (!slug) throw new UnknownSportError(type ?? '(no type in the file)');
	return slug;
}

function firstTag(xml: string, local: string): string | null {
	const m = tagRe(local).exec(xml);
	const v = m?.[1]?.trim();
	return v ? decodeEntities(v) : null;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, '&');
}

const nullable = (v: number): number | null => (Number.isFinite(v) ? v : null);

function average(values: (number | null)[]): number | null {
	const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
	if (!nums.length) return null;
	return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function maximum(values: (number | null)[]): number | null {
	const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
	return nums.length ? Math.max(...nums) : null;
}
