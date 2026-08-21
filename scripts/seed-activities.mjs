// Synthetic training history for the activity log — so the other tracks
// (landing, list, detail, month) have something real to render against before
// the ingest pipeline exists.
//
// Models a Seattle-area athlete over the last 14 months: a cyclist first
// (weekday trainer rides, weekend Cascades/Snoqualmie Valley miles), a
// triathlete second (two real races, parent + swim/T1/bike/T2/run children),
// a hiker third (big-elevation summer days), a skier fourth (winter days at
// the local resorts). Weekday trainer rides and treadmill runs, and pool
// swims, deliberately carry NO gps at all — see ACTIVITIES.md §7, "not every
// activity has a route" — while everything outdoors gets a real-ish lat/lng
// track, an encoded `polyline`, and a normalised `route_path` computed with
// the exact §7 pipeline (implemented inline here, not imported from src/ —
// this script has to run with plain node, no Astro/TS build step).
//
// Usage:
//   node --env-file=.env scripts/seed-activities.mjs             # insert
//   node --env-file=.env scripts/seed-activities.mjs --reset     # wipe seeded rows, then insert
//   node scripts/seed-activities.mjs --sql > seed.sql            # no DB creds needed —
//                                                                 # emit SQL for the SQL editor
//   node scripts/seed-activities.mjs --sql --reset > seed.sql    # same, with the DELETEs first
//   node scripts/seed-activities.mjs --dry                       # just print the summary, write nothing
//
// IDEMPOTENCY. Every row this script writes to `activities` carries a matching
// `activity_sources` row with provider='manual' and file_name=SEED_MARKER
// (below). --reset deletes every activity reachable through that marker (the
// FK cascade takes its streams/laps/sources with it), then the gear rows
// tagged with the same marker in `external_ids`, then clears
// `athlete_thresholds` entirely — that table has no marker column, but
// nothing else writes to it yet, so a full clear-and-reinsert on --reset is
// safe and exact rather than approximate.
import { createClient } from '@supabase/supabase-js';

// --- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const SQL_ONLY = args.includes('--sql');
const DRY = args.includes('--dry');

const SEED_MARKER = 'seed-activities.mjs';

let db = null;
if (!SQL_ONLY && !DRY) {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (node --env-file=.env ...).');
		console.error('No .env available? Run with --sql instead and apply the output through the SQL editor / execute_sql.');
		process.exit(1);
	}
	db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// --- deterministic RNG -------------------------------------------------------
// Seeded so re-running (with --reset) produces the same "history" rather than
// a new one each time — makes the output reviewable and the summary stable.
function mulberry32(seed) {
	let a = seed >>> 0;
	return function rand() {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(0x5eed_ac71);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);
const betweenInt = (lo, hi) => Math.round(between(lo, hi));
const chance = (p) => rand() < p;

// ---------------------------------------------------------------------------
// Geometry — the §7 route-shape pipeline, implemented inline per the task
// (the real, shared version lives in src/lib/route-shape.ts, owned by the
// Effort track; this is deliberately a separate, script-local copy).
// ---------------------------------------------------------------------------

const R_EARTH_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

function haversineM(a, b) {
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const la1 = toRad(a.lat);
	const la2 = toRad(b.lat);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
	return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Web Mercator, in a degrees-ish unit — absolute scale doesn't matter since
 * the result is re-fit to a 0-100 box; only the local aspect ratio has to be
 * right, which this preserves. */
function mercatorProject({ lat, lng }) {
	const y = (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
	return { x: lng, y };
}

function perpendicularDistance(pt, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dx === 0 && dy === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
	const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy);
	const proj = { x: a.x + t * dx, y: a.y + t * dy };
	return Math.hypot(pt.x - proj.x, pt.y - proj.y);
}

function rdpSimplify(points, epsilon) {
	if (points.length < 3) return points;
	let maxDist = 0;
	let maxIdx = 0;
	for (let i = 1; i < points.length - 1; i++) {
		const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
		if (d > maxDist) {
			maxDist = d;
			maxIdx = i;
		}
	}
	if (maxDist > epsilon) {
		const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
		const right = rdpSimplify(points.slice(maxIdx), epsilon);
		return left.slice(0, -1).concat(right);
	}
	return [points[0], points[points.length - 1]];
}

/** RDP, adaptively widening epsilon until the simplified track fits the §7
 * cap of <=200 points (a synthetic track never needs more than a few passes). */
function simplifyToLimit(points, limit = 200) {
	if (points.length <= limit) return points;
	let epsilon = 0.00002;
	let out = points;
	for (let i = 0; i < 30; i++) {
		out = rdpSimplify(points, epsilon);
		if (out.length <= limit) return out;
		epsilon *= 1.6;
	}
	// Fallback: even sampling if RDP still hasn't converged (shouldn't happen
	// for these tracks, but a route_path over the cap is worse than a slightly
	// coarser one).
	const stride = Math.ceil(points.length / limit);
	return points.filter((_, i) => i % stride === 0);
}

/** §7 steps 2-5, given the raw (lat,lng) track. Returns the normalised
 * "M x y L x y …" path string, viewBox 0 0 100 100. */
function buildRoutePath(latlngs) {
	if (latlngs.length < 2) return null;
	const projected = latlngs.map(mercatorProject);
	const simplified = simplifyToLimit(projected, 200);

	const xs = simplified.map((p) => p.x);
	const ys = simplified.map((p) => p.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const w = maxX - minX || 1e-9;
	const h = maxY - minY || 1e-9;

	const PAD = 6;
	const box = 100 - 2 * PAD;
	const scale = box / Math.max(w, h);
	// Centre the (possibly non-square) content within the padded box.
	const drawW = w * scale;
	const drawH = h * scale;
	const offX = PAD + (box - drawW) / 2;
	const offY = PAD + (box - drawH) / 2;

	const toXY = (p) => {
		// SVG y grows downward; mercator y grows northward — flip so north is up.
		const x = offX + (p.x - minX) * scale;
		const y = offY + (maxY - p.y) * scale;
		return `${x.toFixed(1)} ${y.toFixed(1)}`;
	};
	return `M ${toXY(simplified[0])} ` + simplified.slice(1).map((p) => `L ${toXY(p)}`).join(' ');
}

/** Standard Google encoded-polyline algorithm, precision 5. */
function encodePolyline(latlngs) {
	let out = '';
	let prevLat = 0;
	let prevLng = 0;
	const encodeValue = (v) => {
		let value = v < 0 ? ~(v << 1) : v << 1;
		let chunk = '';
		while (value >= 0x20) {
			chunk += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
			value >>= 5;
		}
		chunk += String.fromCharCode(value + 63);
		return chunk;
	};
	for (const { lat, lng } of latlngs) {
		const lat5 = Math.round(lat * 1e5);
		const lng5 = Math.round(lng * 1e5);
		out += encodeValue(lat5 - prevLat) + encodeValue(lng5 - prevLng);
		prevLat = lat5;
		prevLng = lng5;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Synthetic tracks
// ---------------------------------------------------------------------------

/**
 * A correlated random walk from `start`, `steps` points, drifting by up to
 * `headingJitterDeg` per step. Used to build the outbound half of an
 * out-and-back; the return half is a mirror with independent jitter so the
 * two legs of the "loop" don't overlap pixel-for-pixel.
 */
function walkTrack(start, steps, stepM, headingJitterDeg, startHeadingDeg) {
	const pts = [start];
	let heading = startHeadingDeg;
	let cur = start;
	for (let i = 0; i < steps; i++) {
		heading += between(-headingJitterDeg, headingJitterDeg);
		const rad = toRad(heading);
		const dLat = ((stepM * Math.cos(rad)) / R_EARTH_M) * (180 / Math.PI);
		const dLng =
			((stepM * Math.sin(rad)) / (R_EARTH_M * Math.cos(toRad(cur.lat)))) * (180 / Math.PI);
		cur = { lat: cur.lat + dLat, lng: cur.lng + dLng };
		pts.push(cur);
	}
	return pts;
}

/** An out-and-back track (the shape of most training rides/runs/hikes): walk
 * out, then walk back toward the start with independent jitter so it isn't a
 * mirror-image line. Returns { points, elevations, distanceM }. */
function outAndBackTrack(start, { distanceM, elevGainM, hilliness = 0.5 }) {
	const steps = betweenInt(16, 28);
	const stepM = distanceM / 2 / steps;
	const startHeading = between(0, 360);
	const out = walkTrack(start, steps, stepM, 25, startHeading);
	// The way back: walk from the far point roughly toward start, nudged each
	// step so it settles back on start rather than wandering off.
	const far = out[out.length - 1];
	const back = [far];
	let cur = far;
	for (let i = 0; i < steps; i++) {
		const remaining = steps - i;
		const headingToStart =
			(Math.atan2(start.lng - cur.lng, start.lat - cur.lat) * 180) / Math.PI;
		const heading = headingToStart + between(-20, 20);
		const rad = toRad(heading);
		const d = i === steps - 1 ? haversineM(cur, start) : stepM;
		const dLat = ((d * Math.cos(rad)) / R_EARTH_M) * (180 / Math.PI);
		const dLng = ((d * Math.sin(rad)) / (R_EARTH_M * Math.cos(toRad(cur.lat)))) * (180 / Math.PI);
		cur = remaining === 1 ? start : { lat: cur.lat + dLat, lng: cur.lng + dLng };
		back.push(cur);
	}
	const points = out.concat(back.slice(1));

	// Elevation: a random walk biased so the round trip returns to ~base,
	// scaled so its total climbing matches elevGainM.
	const base = between(20, 120);
	const raw = [0];
	for (let i = 1; i < points.length; i++) {
		const towardTurn = i <= steps ? 1 : -1; // climb out, descend back — roughly
		raw.push(raw[i - 1] + towardTurn * Math.abs(between(-1, 1)) * hilliness + between(-0.4, 0.4));
	}
	const maxRaw = Math.max(...raw.map(Math.abs), 1e-6);
	const elevations = raw.map((v) => base + (v / maxRaw) * (elevGainM / 1.6));

	let trackDistanceM = 0;
	for (let i = 1; i < points.length; i++) trackDistanceM += haversineM(points[i - 1], points[i]);
	return { points, elevations, distanceM: trackDistanceM };
}

/** A one-way, downhill track from `top` to a point ~elevLossM below it — one
 * ski run. */
function downhillTrack(top, elevLossM, runDistanceM) {
	const steps = betweenInt(10, 20);
	const stepM = runDistanceM / steps;
	const heading = between(0, 360);
	const points = walkTrack(top, steps, stepM, 15, heading);
	const elevations = points.map((_, i) => -1 * (i / steps) * elevLossM + between(-3, 3));
	let distanceM = 0;
	for (let i = 1; i < points.length; i++) distanceM += haversineM(points[i - 1], points[i]);
	return { points, elevations: elevations.map((e) => e + 1600), distanceM };
}

function elevationStats(elevations) {
	let gain = 0;
	let loss = 0;
	for (let i = 1; i < elevations.length; i++) {
		const d = elevations[i] - elevations[i - 1];
		if (d > 0) gain += d;
		else loss += -d;
	}
	return { gain, loss, high: Math.max(...elevations), low: Math.min(...elevations) };
}

function bboxOf(points) {
	const lats = points.map((p) => p.lat);
	const lngs = points.map((p) => p.lng);
	return { w: Math.min(...lngs), e: Math.max(...lngs), s: Math.min(...lats), n: Math.max(...lats) };
}

/** Downsample a series to ~targetCount points, evenly spaced — how the raw
 * per-step track becomes a stream (a device samples in time, not per RDP
 * vertex, so this is independent of route_path's own simplification). */
function resample(arr, targetCount) {
	if (arr.length <= targetCount) return arr;
	const stride = arr.length / targetCount;
	const out = [];
	for (let i = 0; i < targetCount; i++) out.push(arr[Math.floor(i * stride)]);
	return out;
}

// ---------------------------------------------------------------------------
// World — named Seattle/Cascades locations, gear, thresholds
// ---------------------------------------------------------------------------

const RIDE_STARTS = [
	{ name: 'Capitol Hill, Seattle, WA', lat: 47.6231, lng: -122.3126 },
	{ name: 'Burke-Gilman Trail, Seattle, WA', lat: 47.6511, lng: -122.3547 },
	{ name: 'Lake Washington Loop, Seattle, WA', lat: 47.5511, lng: -122.261 },
	{ name: 'Mercer Island, WA', lat: 47.5707, lng: -122.2221 },
	{ name: 'Sammamish River Trail, Bothell, WA', lat: 47.7601, lng: -122.2054 },
];
const LONG_RIDE_STARTS = [
	{ name: 'Snoqualmie Valley Trail, Duvall, WA', lat: 47.7423, lng: -121.9857 },
	{ name: 'Snoqualmie Falls, WA', lat: 47.5417, lng: -121.8377 },
	{ name: 'Snoqualmie Pass, WA', lat: 47.4247, lng: -121.4131 },
	{ name: 'Issaquah, WA', lat: 47.5301, lng: -122.0326 },
];
const GRAVEL_STARTS = [
	{ name: 'Tiger Mountain State Forest, WA', lat: 47.514, lng: -121.976 },
	{ name: 'Snoqualmie Valley Trail, Carnation, WA', lat: 47.6465, lng: -121.9165 },
];
const MTB_STARTS = [
	{ name: 'Duthie Hill Park, Issaquah, WA', lat: 47.539, lng: -121.9847 },
	{ name: 'Tiger Mountain State Forest, WA', lat: 47.514, lng: -121.976 },
];
const RUN_STARTS = [
	{ name: 'Green Lake, Seattle, WA', lat: 47.6805, lng: -122.3287 },
	{ name: 'Alki Beach, Seattle, WA', lat: 47.5765, lng: -122.4141 },
	{ name: 'Discovery Park, Seattle, WA', lat: 47.6613, lng: -122.415 },
	{ name: 'Capitol Hill, Seattle, WA', lat: 47.6231, lng: -122.3126 },
];
const TRAIL_RUN_STARTS = [
	{ name: 'Cougar Mountain Regional Wildland Park, WA', lat: 47.5387, lng: -122.1235 },
	{ name: 'Squak Mountain State Park, WA', lat: 47.5253, lng: -122.0234 },
	{ name: 'Tiger Mountain State Forest, WA', lat: 47.514, lng: -121.976 },
];
const HIKE_TRAILHEADS = [
	{ name: 'Mount Si Trailhead, North Bend, WA', lat: 47.4852, lng: -121.7331 },
	{ name: 'Rattlesnake Ledge Trailhead, North Bend, WA', lat: 47.4327, lng: -121.7692 },
	{ name: 'Poo Poo Point, Issaquah, WA', lat: 47.5197, lng: -122.0324 },
	{ name: 'Mailbox Peak Trailhead, North Bend, WA', lat: 47.4661, lng: -121.6749 },
	{ name: 'Twin Falls Trailhead, North Bend, WA', lat: 47.4402, lng: -121.7275 },
	{ name: 'Granite Mountain Trailhead, Snoqualmie Pass, WA', lat: 47.4407, lng: -121.5942 },
];
const SKI_RESORTS = [
	{ name: 'The Summit at Snoqualmie, WA', lat: 47.4237, lng: -121.4131 },
	{ name: 'Stevens Pass, WA', lat: 47.7448, lng: -121.089 },
	{ name: 'Crystal Mountain, WA', lat: 46.9366, lng: -121.4747 },
];
const POOLS = [
	{ name: 'Green Lake Community Center Pool, Seattle, WA', lat: 47.6785, lng: -122.3255 },
	{ name: 'Weyerhaeuser King County Aquatic Center, Federal Way, WA', lat: 47.3327, lng: -122.3123 },
];
const TRI_VENUES = [
	{ name: 'Lake Sammamish State Park, Issaquah, WA', lat: 47.5698, lng: -122.0731 },
	{ name: 'Lake Meridian Park, Kent, WA', lat: 47.3763, lng: -122.1838 },
];
const HOME_GYM = 'Capitol Hill, Seattle, WA';

const DEVICES = ['Garmin Edge 830', 'Garmin Fenix 7', 'Wahoo ELEMNT Bolt', 'Garmin Forerunner 955'];

// --- gear (activity_gear) ---
const GEAR = [
	{ key: 'gravel', kind: 'bike', name: '2023 Salsa Cutthroat', brand: 'Salsa', model: 'Cutthroat', nickname: 'the gravel bike' },
	{ key: 'road', kind: 'bike', name: '2022 Cervélo Caledonia-5', brand: 'Cervélo', model: 'Caledonia-5', nickname: 'the road bike' },
	{ key: 'tt', kind: 'bike', name: '2021 Trek Speed Concept', brand: 'Trek', model: 'Speed Concept', nickname: 'the tri bike' },
	{ key: 'mtb', kind: 'bike', name: '2020 Santa Cruz Tallboy', brand: 'Santa Cruz', model: 'Tallboy', nickname: 'the mountain bike' },
	{ key: 'trail_shoes', kind: 'shoes', name: 'Hoka Speedgoat 5', brand: 'Hoka', model: 'Speedgoat 5', nickname: 'trail shoes' },
	{ key: 'road_shoes', kind: 'shoes', name: 'Nike Vaporfly 3', brand: 'Nike', model: 'Vaporfly 3', nickname: 'road shoes' },
	{ key: 'skis', kind: 'skis', name: 'Nordica Enforcer 94', brand: 'Nordica', model: 'Enforcer 94', nickname: 'the skis' },
];

// --- athlete_thresholds ---
// Two rows: an early-season baseline and a late-season build. Dates are
// filled in relative to the generation window once that's known (below).

// ---------------------------------------------------------------------------
// Generation window
// ---------------------------------------------------------------------------
const today = new Date();
const startDate = new Date(today);
startDate.setMonth(startDate.getMonth() - 14);

function fmtDate(d) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) {
	const out = new Date(d);
	out.setDate(out.getDate() + n);
	return out;
}
function monthOf(d) {
	return d.getMonth() + 1; // 1-12
}
const isWinter = (d) => [12, 1, 2, 3].includes(monthOf(d));
const isSummer = (d) => [6, 7, 8, 9].includes(monthOf(d));

const THRESHOLD_ROWS = [
	{
		key: 'th1',
		effective_from: fmtDate(startDate),
		ftp_w: 235,
		lthr_bpm: 162,
		max_hr: 187,
		rest_hr: 50,
		threshold_pace_s_per_km: 295, // ~4:55/km
		css_pace_s_per_100m: 98,
		weight_kg: 73.5,
	},
	{
		key: 'th2',
		effective_from: fmtDate(addDays(startDate, 210)), // ~7 months in — the "build"
		ftp_w: 258,
		lthr_bpm: 164,
		max_hr: 188,
		rest_hr: 47,
		threshold_pace_s_per_km: 278, // ~4:38/km
		css_pace_s_per_100m: 93,
		weight_kg: 71.8,
	},
];
function thresholdsFor(dateStr) {
	let best = THRESHOLD_ROWS[0];
	for (const t of THRESHOLD_ROWS) if (t.effective_from <= dateStr) best = t;
	return best;
}

// --- pick the two triathlon Saturdays: one summer weekend near the start of
// the range's first full summer, one ~8 weeks later.
function findTriathlonDates() {
	const summerSaturdays = [];
	for (let d = new Date(startDate); d <= today; d = addDays(d, 1)) {
		if (d.getDay() === 6 && isSummer(d)) summerSaturdays.push(new Date(d));
	}
	if (summerSaturdays.length < 2) return [];
	const first = summerSaturdays[Math.floor(summerSaturdays.length * 0.3)];
	const second = summerSaturdays[Math.floor(summerSaturdays.length * 0.75)];
	return [first, second].filter(Boolean);
}
const triathlonDates = new Set(findTriathlonDates().map(fmtDate));

// ---------------------------------------------------------------------------
// Exertion — a plausible, simplified stand-in for the §3 cascade. The real
// implementation (pure functions over streams) is src/lib/exertion.ts, owned
// by the Effort track; this is deliberately a much smaller approximation
// used only to fill exertion/exertion_method/exertion_confidence with
// internally-consistent, plausible numbers for the seed data.
// ---------------------------------------------------------------------------
function computeExertion({ movingSeconds, hasPowerStream, avgPower, hasHrStream, avgHr, sport, distanceM, dateStr }) {
	const th = thresholdsFor(dateStr);
	const hours = movingSeconds / 3600;
	if (hasPowerStream && avgPower && th.ftp_w) {
		// Normalized power approximated as ~5% above average for these synthetic
		// rides (a steady-ish effort, not a crit).
		const np = avgPower * 1.05;
		const IF = np / th.ftp_w;
		const exertion = (movingSeconds * np * IF) / (th.ftp_w * 3600) * 100;
		return { exertion: round1(exertion), method: 'tss', confidence: 'measured', intensityFactor: round2(IF) };
	}
	if (hasHrStream && avgHr && th.lthr_bpm && th.rest_hr) {
		const hrr = (avgHr - th.rest_hr) / (th.lthr_bpm - th.rest_hr);
		const trimp = movingSeconds / 60 * hrr * 0.64 * Math.exp(1.92 * hrr);
		// Rescale so an hour at threshold (hrr=1) reads ~100.
		const hourAtThreshold = 60 * 1 * 0.64 * Math.exp(1.92);
		const exertion = (trimp / hourAtThreshold) * 100;
		return { exertion: round1(exertion), method: 'hrtss', confidence: 'measured', intensityFactor: round2(hrr) };
	}
	if (avgHr && th.lthr_bpm && th.rest_hr) {
		const hrr = (avgHr - th.rest_hr) / (th.lthr_bpm - th.rest_hr);
		const trimp = movingSeconds / 60 * hrr * 0.64 * Math.exp(1.92 * hrr);
		const hourAtThreshold = 60 * 1 * 0.64 * Math.exp(1.92);
		const exertion = (trimp / hourAtThreshold) * 100;
		return { exertion: round1(exertion), method: 'avghr', confidence: 'estimated', intensityFactor: round2(hrr) };
	}
	if ((sport === 'run' || sport === 'trail_run' || sport === 'treadmill_run') && distanceM && th.threshold_pace_s_per_km) {
		const paceSPerKm = movingSeconds / (distanceM / 1000);
		const IF = th.threshold_pace_s_per_km / paceSPerKm; // faster than threshold pace -> IF > 1
		const exertion = hours * IF * IF * 100;
		return { exertion: round1(exertion), method: 'ptss', confidence: 'estimated', intensityFactor: round2(IF) };
	}
	if ((sport === 'swim' || sport === 'open_water_swim') && distanceM && th.css_pace_s_per_100m) {
		const paceS100 = movingSeconds / (distanceM / 100);
		const IF = th.css_pace_s_per_100m / paceS100;
		const exertion = hours * IF * IF * 100;
		return { exertion: round1(exertion), method: 'ptss', confidence: 'estimated', intensityFactor: round2(IF) };
	}
	// Floor: MET-minutes, scaled to sit in roughly the same 0-500 range as the
	// other methods. sportMet is a small local table, not src/lib/sports.ts's
	// (this script intentionally doesn't import from src/ — see the header).
	const met = sportMet(sport);
	const exertion = met * hours * 12;
	return { exertion: round1(exertion), method: 'met', confidence: 'assumed', intensityFactor: null };
}
function sportMet(sport) {
	const table = {
		ride: 8, gravel_ride: 8.5, mountain_bike: 8.5, virtual_ride: 8,
		run: 10, treadmill_run: 9.5, trail_run: 11,
		swim: 8, open_water_swim: 9,
		hike: 6.5, walk: 3.5, snowshoe: 7.5,
		alpine_ski: 6, backcountry_ski: 9, nordic_ski: 9.5, snowboard: 5.5,
		strength: 5, yoga: 3, rowing: 7, transition: 4, other: 5,
	};
	return table[sport] ?? 5;
}
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Record builders — plain descriptor objects, wired by string keys so both
// commit paths (live insert / SQL emit) can resolve real ids their own way.
// ---------------------------------------------------------------------------
let nextActivityKey = 1;
const activities = []; // { key, ...columns, gearKey, parentKey }
const streamsByKey = new Map();
const lapsByKey = new Map();
const sourceByKey = new Map();

function newKey() {
	return nextActivityKey++;
}

function addSource(key, extra = {}) {
	sourceByKey.set(key, {
		provider: 'manual',
		external_id: null,
		external_url: null,
		file_name: SEED_MARKER,
		file_checksum: null,
		fidelity: 1,
		raw: { seed: true, generator: SEED_MARKER },
		imported_at: new Date().toISOString(),
		...extra,
	});
}

/** Build streams from a synthetic track + effort profile, then downsample to
 * a device-plausible sample count (not one row per RDP vertex — see
 * resample's comment). */
function buildStreams({ points, elevations, movingSeconds, avgHr, maxHr, avgPower, maxPower, avgSpeed, maxSpeed, hasPower, hasHr, temp }) {
	// Deliberately coarser than a real device's 1Hz stream — this is synthetic
	// seed data, not a fixture for testing stream-heavy rendering at scale, and
	// keeping each row small matters more than sample density here.
	const targetSamples = Math.max(12, Math.min(50, Math.round(movingSeconds / 90)));
	const n = points.length;
	const idx = resample(
		Array.from({ length: n }, (_, i) => i),
		targetSamples,
	);
	const sampleCount = idx.length;
	const time_s = idx.map((_, i) => Math.round((i / (sampleCount - 1 || 1)) * movingSeconds));
	const round5 = (v) => Math.round(v * 1e5) / 1e5; // ~1.1m — plenty for a stream sample
	const latlng = idx.map((i) => [round5(points[i].lat), round5(points[i].lng)]);
	const altitude_m = idx.map((i) => round1(elevations[i]));
	let cum = 0;
	const distArr = [];
	for (let i = 0; i < idx.length; i++) {
		if (i > 0) cum += haversineM(points[idx[i - 1]], points[idx[i]]);
		distArr.push(Math.round(cum));
	}
	const wobble = (base, spread) => idx.map(() => Math.round(base + between(-spread, spread)));
	return {
		sample_count: sampleCount,
		time_s,
		latlng,
		altitude_m,
		distance_m: distArr,
		heartrate: hasHr ? wobble(avgHr, 8).map((v) => Math.max(80, Math.min(maxHr, v))) : null,
		cadence: null,
		power_w: hasPower ? wobble(avgPower, avgPower * 0.15).map((v) => Math.max(0, Math.min(maxPower, v))) : null,
		speed_ms: wobble(avgSpeed, avgSpeed * 0.2).map((v) => round2(Math.max(0, Math.min(maxSpeed, v)))),
		temp_c: idx.map(() => round1(temp + between(-1, 1))),
		grade: idx.map((i, k) => (k === 0 ? 0 : round1(((altitude_m[k] - altitude_m[k - 1]) / (distArr[k] - distArr[k - 1] || 1)) * 100))),
		moving: idx.map(() => true),
	};
}

/**
 * Push one activity (standalone or a multisport leg) and return its key.
 * `track` is optional — omitting it is how a trainer ride / treadmill run /
 * pool swim ends up with no gps at all.
 */
function pushActivity({
	sport, subSport = null, parentKey = null, leg = null, title, startedAt,
	movingSeconds, elapsedSecondsOverride = null, distanceM = null,
	elevGainM = null, elevLossM = null, avgHr = null, maxHr = null,
	avgPower = null, maxPower = null, avgCadence = null, calories = null,
	avgTempC = null, poolLengthM = null, totalStrokes = null, avgSwolf = null,
	gearKey = null, track = null, placeName = null, placePoint = null,
	favoriteRank = null, hasStreamsOverride = null, deviceName = undefined,
}) {
	const key = newKey();
	const localDate = startedAt.slice(0, 10);
	const elapsedSeconds = elapsedSecondsOverride ?? movingSeconds;
	const avgSpeed = distanceM && movingSeconds ? distanceM / movingSeconds : null;
	const maxSpeed = avgSpeed != null ? avgSpeed * between(1.15, 1.4) : null;

	let start_lat = null, start_lng = null, end_lat = null, end_lng = null;
	let bbox = null, polyline = null, route_path = null;
	if (track) {
		const { points } = track;
		start_lat = points[0].lat;
		start_lng = points[0].lng;
		end_lat = points[points.length - 1].lat;
		end_lng = points[points.length - 1].lng;
		bbox = bboxOf(points);
		polyline = encodePolyline(points);
		route_path = buildRoutePath(points);
	} else if (placePoint) {
		start_lat = placePoint.lat;
		start_lng = placePoint.lng;
	}

	const hasPowerStream = track != null && avgPower != null;
	const hasHrStream = track != null && avgHr != null;
	const { exertion, method, confidence, intensityFactor } = sport === 'transition'
		? { exertion: null, method: null, confidence: null, intensityFactor: null }
		: computeExertion({
				movingSeconds, hasPowerStream, avgPower, hasHrStream, avgHr, sport, distanceM, dateStr: localDate,
			});

	const hasStreams = hasStreamsOverride ?? (track != null);

	activities.push({
		key, sport, sub_sport: subSport, parentKey, leg,
		title, notes: null, private_notes: null,
		started_at: startedAt, local_date: localDate,
		utc_offset_minutes: -420, timezone: 'America/Los_Angeles',
		elapsed_seconds: Math.round(elapsedSeconds), moving_seconds: Math.round(movingSeconds),
		distance_m: distanceM != null ? round1(distanceM) : null,
		elevation_gain_m: elevGainM != null ? round1(elevGainM) : null,
		elevation_loss_m: elevLossM != null ? round1(elevLossM) : null,
		elev_high_m: track ? round1(elevationStats(track.elevations).high) : null,
		elev_low_m: track ? round1(elevationStats(track.elevations).low) : null,
		avg_speed_ms: avgSpeed != null ? round2(avgSpeed) : null,
		max_speed_ms: maxSpeed != null ? round2(maxSpeed) : null,
		avg_hr: avgHr, max_hr: maxHr, avg_cadence: avgCadence,
		avg_power_w: avgPower, max_power_w: maxPower,
		normalized_power_w: avgPower != null ? Math.round(avgPower * 1.05) : null,
		work_kj: avgPower != null ? Math.round((avgPower * movingSeconds) / 1000) : null,
		calories, avg_temp_c: avgTempC,
		pool_length_m: poolLengthM, total_strokes: totalStrokes, avg_swolf: avgSwolf,
		exertion, exertion_method: method, exertion_confidence: confidence, intensity_factor: intensityFactor,
		polyline, route_path, start_lat, start_lng, end_lat, end_lng,
		bbox_w: bbox?.w ?? null, bbox_s: bbox?.s ?? null, bbox_e: bbox?.e ?? null, bbox_n: bbox?.n ?? null,
		start_place: placeName,
		gearKey, favorite_rank: favoriteRank, has_streams: hasStreams,
		device_name: deviceName === undefined ? pick(DEVICES) : deviceName,
	});

	if (track && hasStreams) {
		streamsByKey.set(
			key,
			buildStreams({
				points: track.points, elevations: track.elevations, movingSeconds,
				avgHr: avgHr ?? 120, maxHr: maxHr ?? 150, avgPower: avgPower ?? 150, maxPower: maxPower ?? 300,
				avgSpeed: avgSpeed ?? 3, maxSpeed: maxSpeed ?? 5, hasPower: avgPower != null, hasHr: avgHr != null,
				temp: avgTempC ?? 12,
			}),
		);
	}
	addSource(key);
	return key;
}

// ---------------------------------------------------------------------------
// The training calendar
// ---------------------------------------------------------------------------

function generateRideOrRun(d) {
	const dateStr = fmtDate(d);
	const startedAt = new Date(d);
	const weekend = d.getDay() === 0 || d.getDay() === 6;
	const winter = isWinter(d);
	const summer = isSummer(d);
	const temp = winter ? between(1, 8) : summer ? between(15, 27) : between(8, 16);

	// Rest days are the default, not the exception — this gate keeps the
	// overall count near the ~180 target regardless of season without
	// disturbing the relative mix of activity types below (chosen once this
	// gate is already passed).
	if (!chance(0.535)) return null;

	if (weekend) {
		const r = rand();
		if (winter && chance(0.4)) return generateSkiDay(startedAt, temp);
		if (summer && r < 0.32) return generateHike(startedAt, temp);
		if (r < 0.62) return generateLongRide(startedAt, temp);
		if (r < 0.74) return generateTrailRunOrWalk(startedAt, temp);
		if (r < 0.85) return generatePoolSwim(startedAt);
		return null; // rest day
	}
	// weekday
	const r = rand();
	if (r < 0.34) return generateTrainerRide(startedAt, temp);
	if (r < 0.55) return generateWeekdayRun(startedAt, temp);
	if (r < 0.65) return generatePoolSwim(startedAt);
	if (r < 0.72) return generateStrengthOrYoga(startedAt);
	return null; // rest day
}

function withHour(d, h, m = 0) {
	const out = new Date(d);
	out.setHours(h, m, 0, 0);
	return out.toISOString();
}

function generateLongRide(d, temp) {
	const sportRoll = rand();
	const sport = sportRoll < 0.55 ? 'ride' : sportRoll < 0.8 ? 'gravel_ride' : 'mountain_bike';
	const start =
		sport === 'gravel_ride' ? pick(GRAVEL_STARTS) :
		sport === 'mountain_bike' ? pick(MTB_STARTS) :
		chance(0.6) ? pick(LONG_RIDE_STARTS) : pick(RIDE_STARTS);
	const distanceM = sport === 'mountain_bike' ? between(18000, 38000) : between(48000, 118000);
	const elevGainM = sport === 'mountain_bike' ? between(350, 850) : between(350, 1700);
	const movingSeconds = distanceM / (sport === 'mountain_bike' ? between(3.3, 4.6) : between(6.5, 8.4));
	const track = outAndBackTrack(start, { distanceM, elevGainM, hilliness: sport === 'mountain_bike' ? 0.8 : 0.6 });
	const stats = elevationStats(track.elevations);
	const avgPower = Math.round(between(140, 235));
	const avgHr = Math.round(between(122, 152));
	return pushActivity({
		sport, subSport: sport === 'ride' ? (chance(0.3) ? 'road' : null) : null,
		title: `${sport === 'mountain_bike' ? 'MTB' : sport === 'gravel_ride' ? 'Gravel ride' : 'Ride'} — ${start.name.split(',')[0]}`,
		startedAt: withHour(d, betweenInt(8, 10)),
		movingSeconds, distanceM: track.distanceM,
		elevGainM: stats.gain, elevLossM: stats.loss,
		avgHr, maxHr: Math.round(avgHr * between(1.12, 1.25)),
		avgPower, maxPower: Math.round(avgPower * between(1.6, 2.3)),
		avgCadence: Math.round(between(78, 92)),
		calories: Math.round((movingSeconds / 3600) * between(500, 780)),
		avgTempC: round1(temp),
		gearKey: sport === 'mountain_bike' ? 'mtb' : sport === 'gravel_ride' ? 'gravel' : 'road',
		track, placeName: start.name,
	});
}

function generateTrainerRide(d, temp) {
	const movingSeconds = between(2700, 5400);
	const avgPower = Math.round(between(155, 220));
	const avgHr = Math.round(between(128, 155));
	return pushActivity({
		sport: 'virtual_ride', subSport: 'indoor',
		title: pick(['Zwift — endurance', 'Zwift — sweet spot intervals', 'Trainer — threshold set', 'Zwift group ride']),
		startedAt: withHour(d, chance(0.7) ? betweenInt(6, 7) : betweenInt(18, 20)),
		movingSeconds, distanceM: round1((movingSeconds / 3600) * between(28000, 34000)),
		avgHr, maxHr: Math.round(avgHr * between(1.1, 1.2)),
		avgPower, maxPower: Math.round(avgPower * between(1.7, 2.4)),
		avgCadence: Math.round(between(82, 95)),
		calories: Math.round((movingSeconds / 3600) * between(600, 760)),
		avgTempC: 21, gearKey: chance(0.5) ? 'road' : 'gravel',
		track: null, placeName: null,
		deviceName: pick(['Wahoo KICKR', 'Zwift']),
	});
}

function generateWeekdayRun(d, temp) {
	const outdoor = chance(0.55);
	const distanceM = between(5000, 13000);
	const paceSPerKm = between(285, 360);
	const movingSeconds = (distanceM / 1000) * paceSPerKm;
	const avgHr = Math.round(between(138, 165));
	if (!outdoor) {
		return pushActivity({
			sport: 'treadmill_run',
			title: pick(['Treadmill — easy', 'Treadmill — tempo', 'Treadmill run']),
			startedAt: withHour(d, chance(0.6) ? betweenInt(6, 7) : betweenInt(18, 20)),
			movingSeconds, distanceM,
			avgHr, maxHr: Math.round(avgHr * between(1.08, 1.18)),
			avgCadence: Math.round(between(168, 182)),
			calories: Math.round((movingSeconds / 3600) * between(600, 820)),
			avgTempC: 21, gearKey: 'road_shoes', track: null, placeName: null,
		});
	}
	const start = pick(RUN_STARTS);
	const track = outAndBackTrack(start, { distanceM, elevGainM: between(15, 90), hilliness: 0.25 });
	const stats = elevationStats(track.elevations);
	// Occasionally forgot the chest strap: GPS + pace but no HR at all — the
	// exertion cascade's ptss branch (pace + threshold pace) rather than hrtss.
	const strapless = chance(0.28);
	return pushActivity({
		sport: 'run',
		title: `Run — ${start.name.split(',')[0]}`,
		startedAt: withHour(d, chance(0.6) ? betweenInt(6, 7) : betweenInt(18, 20)),
		movingSeconds, distanceM: track.distanceM,
		elevGainM: stats.gain, elevLossM: stats.loss,
		avgHr: strapless ? null : avgHr, maxHr: strapless ? null : Math.round(avgHr * between(1.08, 1.18)),
		avgCadence: Math.round(between(168, 182)),
		calories: Math.round((movingSeconds / 3600) * between(600, 820)),
		avgTempC: round1(temp), gearKey: 'road_shoes', track, placeName: start.name,
	});
}

function generateTrailRunOrWalk(d, temp) {
	if (chance(0.75)) {
		const start = pick(TRAIL_RUN_STARTS);
		const distanceM = between(11000, 23000);
		const elevGainM = between(400, 1100);
		const movingSeconds = distanceM / between(1.6, 2.3);
		const track = outAndBackTrack(start, { distanceM, elevGainM, hilliness: 0.9 });
		const stats = elevationStats(track.elevations);
		const avgHr = Math.round(between(140, 162));
		return pushActivity({
			sport: 'trail_run', title: `Trail run — ${start.name.split(',')[0]}`,
			startedAt: withHour(d, betweenInt(7, 9)),
			movingSeconds, distanceM: track.distanceM,
			elevGainM: stats.gain, elevLossM: stats.loss,
			avgHr, maxHr: Math.round(avgHr * between(1.1, 1.2)),
			avgCadence: Math.round(between(160, 174)),
			calories: Math.round((movingSeconds / 3600) * between(650, 900)),
			avgTempC: round1(temp), gearKey: 'trail_shoes', track, placeName: start.name,
		});
	}
	const start = pick(RUN_STARTS);
	const distanceM = between(3200, 6000);
	const movingSeconds = distanceM / between(1.1, 1.4);
	const track = outAndBackTrack(start, { distanceM, elevGainM: between(10, 40), hilliness: 0.15 });
	return pushActivity({
		sport: 'walk', title: `Walk — ${start.name.split(',')[0]}`,
		startedAt: withHour(d, betweenInt(9, 17)),
		movingSeconds, distanceM: track.distanceM,
		avgHr: Math.round(between(95, 115)), maxHr: Math.round(between(120, 135)),
		calories: Math.round((movingSeconds / 3600) * between(220, 320)),
		avgTempC: round1(temp), track, placeName: start.name,
	});
}

function generatePoolSwim(d) {
	const pool = pick(POOLS);
	const distanceM = pick([1500, 1800, 2000, 2200, 2500, 3000]);
	const paceS100 = between(88, 115);
	const movingSeconds = (distanceM / 100) * paceS100;
	const avgHr = Math.round(between(118, 140));
	return pushActivity({
		sport: 'swim', subSport: 'pool',
		title: 'Pool swim',
		startedAt: withHour(d, chance(0.65) ? betweenInt(6, 7) : betweenInt(18, 20)),
		movingSeconds, distanceM,
		avgHr, maxHr: Math.round(avgHr * between(1.05, 1.15)),
		calories: Math.round((movingSeconds / 3600) * between(450, 620)),
		avgTempC: 27,
		poolLengthM: 25, totalStrokes: Math.round((distanceM / 25) * between(14, 19)),
		avgSwolf: Math.round(between(32, 44)),
		track: null, placeName: pool.name, placePoint: pool,
		hasStreamsOverride: false,
	});
}

function generateStrengthOrYoga(d) {
	const yoga = chance(0.4);
	const movingSeconds = between(1800, 3600);
	return pushActivity({
		sport: yoga ? 'yoga' : 'strength',
		title: yoga ? 'Yoga' : 'Strength — full body',
		startedAt: withHour(d, chance(0.5) ? betweenInt(6, 7) : betweenInt(19, 21)),
		movingSeconds,
		avgHr: yoga ? Math.round(between(85, 100)) : Math.round(between(105, 125)),
		maxHr: yoga ? Math.round(between(105, 120)) : Math.round(between(135, 155)),
		calories: Math.round((movingSeconds / 3600) * (yoga ? between(180, 260) : between(280, 420))),
		avgTempC: 21, track: null, placeName: HOME_GYM,
		hasStreamsOverride: false,
	});
}

function generateHike(d, temp) {
	const start = pick(HIKE_TRAILHEADS);
	const distanceM = between(9000, 19000);
	const elevGainM = between(650, 1450);
	const movingSeconds = distanceM / between(0.75, 1.05);
	const track = outAndBackTrack(start, { distanceM, elevGainM, hilliness: 1.1 });
	const stats = elevationStats(track.elevations);
	const avgHr = Math.round(between(122, 148));
	// A dead watch battery on the summit push — no HR at all, and hiking isn't
	// one of the pace-based sports either, so this is exactly the case
	// ACTIVITIES.md §3 describes for the MET floor: "works for everything,
	// including a hike with a dead watch".
	const deadWatch = chance(0.35);
	return pushActivity({
		sport: 'hike', title: `Hike — ${start.name.split(',')[0]}`,
		startedAt: withHour(d, betweenInt(7, 9)),
		movingSeconds, elapsedSecondsOverride: movingSeconds * between(1.15, 1.4), // summit breaks, photos
		distanceM: track.distanceM, elevGainM: stats.gain, elevLossM: stats.loss,
		avgHr: deadWatch ? null : avgHr, maxHr: deadWatch ? null : Math.round(avgHr * between(1.08, 1.18)),
		calories: Math.round((movingSeconds / 3600) * between(450, 650)),
		avgTempC: round1(temp), gearKey: 'trail_shoes', track, placeName: start.name,
	});
}

function generateSkiDay(d, temp) {
	const resort = pick(SKI_RESORTS);
	const runCount = betweenInt(8, 16);
	const elevLossPerRun = between(220, 420);
	let totalMoving = 0;
	let totalLoss = 0;
	let maxSpeed = 0;
	let firstTrack = null;
	let startedAt = withHour(d, betweenInt(8, 9));
	const key = newKey(); // parent-less standalone; reserve key first for laps
	const laps = [];
	let lapStart = new Date(startedAt);
	for (let i = 0; i < runCount; i++) {
		const runDistanceM = between(900, 2400);
		const runSeconds = runDistanceM / between(9, 15);
		const track = downhillTrack(resort, elevLossPerRun, runDistanceM);
		if (!firstTrack) firstTrack = track;
		const runMaxSpeed = between(14, 24);
		maxSpeed = Math.max(maxSpeed, runMaxSpeed);
		totalMoving += runSeconds;
		totalLoss += elevLossPerRun;
		laps.push({
			lap_index: i + 1, name: `Run ${i + 1}`, start_time: lapStart.toISOString(),
			elapsed_seconds: Math.round(runSeconds * between(1.3, 1.7)), moving_seconds: Math.round(runSeconds),
			distance_m: round1(runDistanceM), avg_hr: Math.round(between(110, 140)),
			max_hr: Math.round(between(140, 165)), avg_power_w: null,
			avg_speed_ms: round2(runDistanceM / runSeconds), elevation_gain_m: 0, lap_type: 'lap',
		});
		lapStart = addDays(lapStart, 0);
		lapStart = new Date(lapStart.getTime() + (runSeconds + between(400, 900)) * 1000); // + lift ride
	}
	const elapsedSeconds = totalMoving + runCount * between(500, 850); // lift queues/rides
	const avgHr = Math.round(between(115, 138));
	lapsByKey.set(key, laps);

	activities.push({
		key, sport: 'alpine_ski', sub_sport: 'resort', parentKey: null, leg: null,
		title: `Ski day — ${resort.name.split(',')[0]}`, notes: null, private_notes: null,
		started_at: startedAt, local_date: startedAt.slice(0, 10),
		utc_offset_minutes: -480, timezone: 'America/Los_Angeles',
		elapsed_seconds: Math.round(elapsedSeconds), moving_seconds: Math.round(totalMoving),
		distance_m: round1(laps.reduce((s, l) => s + l.distance_m, 0)),
		elevation_gain_m: round1(runCount * 15), // negligible foot-powered gain; lift-served
		elevation_loss_m: round1(totalLoss),
		elev_high_m: round1(1650), elev_low_m: round1(1650 - totalLoss / runCount),
		avg_speed_ms: round2(laps.reduce((s, l) => s + l.distance_m, 0) / totalMoving),
		max_speed_ms: round2(maxSpeed),
		avg_hr: avgHr, max_hr: Math.round(avgHr * 1.2), avg_cadence: null,
		avg_power_w: null, max_power_w: null, normalized_power_w: null, work_kj: null,
		calories: Math.round((elapsedSeconds / 3600) * between(400, 550)),
		avg_temp_c: round1(temp - between(3, 8)),
		pool_length_m: null, total_strokes: null, avg_swolf: null,
		...computeExertionFields({ movingSeconds: totalMoving, avgHr, sport: 'alpine_ski', dateStr: startedAt.slice(0, 10) }),
		polyline: firstTrack ? encodePolyline(firstTrack.points) : null,
		route_path: firstTrack ? buildRoutePath(firstTrack.points) : null,
		start_lat: resort.lat, start_lng: resort.lng, end_lat: resort.lat, end_lng: resort.lng,
		bbox_w: resort.lng - 0.01, bbox_s: resort.lat - 0.01, bbox_e: resort.lng + 0.01, bbox_n: resort.lat + 0.01,
		start_place: resort.name, gearKey: 'skis', favorite_rank: null, has_streams: true,
		device_name: pick(DEVICES),
	});
	addSource(key);
	return key;
}
function computeExertionFields(args) {
	const r = computeExertion({ hasPowerStream: false, hasHrStream: true, avgPower: null, distanceM: null, ...args });
	return { exertion: r.exertion, exertion_method: r.method, exertion_confidence: r.confidence, intensity_factor: r.intensityFactor };
}

function generateTriathlon(d) {
	const venue = pick(TRI_VENUES);
	const startedAt = withHour(d, 8);
	const parentKey = newKey();

	// --- legs ---
	const swimDistanceM = 1500;
	const swimSeconds = swimDistanceM * between(0.028, 0.034);
	const swimAvgHr = Math.round(between(140, 158));
	const swimTrack = outAndBackTrack(venue, { distanceM: swimDistanceM, elevGainM: 0, hilliness: 0 });
	const swimKey = pushActivity({
		sport: 'open_water_swim', parentKey, leg: 1, title: 'Triathlon — swim leg',
		startedAt, movingSeconds: swimSeconds, distanceM: swimDistanceM,
		avgHr: swimAvgHr, maxHr: Math.round(swimAvgHr * 1.1),
		calories: Math.round((swimSeconds / 3600) * 550),
		avgTempC: 19, track: swimTrack, placeName: venue.name,
	});

	const t1Start = new Date(new Date(startedAt).getTime() + swimSeconds * 1000).toISOString();
	const t1Seconds = between(120, 240);
	const t1Key = pushActivity({
		sport: 'transition', parentKey, leg: 2, title: 'T1 — swim to bike',
		startedAt: t1Start, movingSeconds: t1Seconds, track: null, placeName: venue.name,
	});

	const bikeStart = new Date(new Date(t1Start).getTime() + t1Seconds * 1000).toISOString();
	const bikeDistanceM = 40000;
	const bikeAvgPower = Math.round(between(195, 235));
	const bikeSeconds = bikeDistanceM / between(9.5, 11.2);
	const bikeTrack = outAndBackTrack(venue, { distanceM: bikeDistanceM, elevGainM: between(250, 500), hilliness: 0.4 });
	const bikeStats = elevationStats(bikeTrack.elevations);
	const bikeAvgHr = Math.round(between(150, 168));
	const bikeKey = pushActivity({
		sport: 'ride', subSport: 'road', parentKey, leg: 3, title: 'Triathlon — bike leg',
		startedAt: bikeStart, movingSeconds: bikeSeconds, distanceM: bikeTrack.distanceM,
		elevGainM: bikeStats.gain, elevLossM: bikeStats.loss,
		avgHr: bikeAvgHr, maxHr: Math.round(bikeAvgHr * 1.12),
		avgPower: bikeAvgPower, maxPower: Math.round(bikeAvgPower * 1.8),
		avgCadence: Math.round(between(85, 95)),
		calories: Math.round((bikeSeconds / 3600) * 680),
		avgTempC: 22, gearKey: 'tt', track: bikeTrack, placeName: venue.name,
	});

	const t2Start = new Date(new Date(bikeStart).getTime() + bikeSeconds * 1000).toISOString();
	const t2Seconds = between(90, 180);
	const t2Key = pushActivity({
		sport: 'transition', parentKey, leg: 4, title: 'T2 — bike to run',
		startedAt: t2Start, movingSeconds: t2Seconds, track: null, placeName: venue.name,
	});

	const runStart = new Date(new Date(t2Start).getTime() + t2Seconds * 1000).toISOString();
	const runDistanceM = 10000;
	const runSeconds = runDistanceM * between(0.245, 0.29);
	const runTrack = outAndBackTrack(venue, { distanceM: runDistanceM, elevGainM: between(40, 110), hilliness: 0.3 });
	const runStats = elevationStats(runTrack.elevations);
	const runAvgHr = Math.round(between(158, 174));
	const runKey = pushActivity({
		sport: 'run', parentKey, leg: 5, title: 'Triathlon — run leg',
		startedAt: runStart, movingSeconds: runSeconds, distanceM: runTrack.distanceM,
		elevGainM: runStats.gain, elevLossM: runStats.loss,
		avgHr: runAvgHr, maxHr: Math.round(runAvgHr * 1.08),
		avgCadence: Math.round(between(172, 184)),
		calories: Math.round((runSeconds / 3600) * 820),
		avgTempC: 23, gearKey: 'road_shoes', track: runTrack, placeName: venue.name,
	});

	// --- parent: the whole race ---
	const totalMoving = swimSeconds + t1Seconds + bikeSeconds + t2Seconds + runSeconds;
	const totalElapsed = totalMoving; // chip time ~ sum of the legs for this synthetic race
	const totalDistance = swimDistanceM + bikeTrack.distanceM + runTrack.distanceM;
	const parentExertion =
		computeExertion({ movingSeconds: bikeSeconds, hasPowerStream: true, avgPower: bikeAvgPower, sport: 'ride', dateStr: startedAt.slice(0, 10) }).exertion +
		computeExertion({ movingSeconds: swimSeconds, hasHrStream: true, avgHr: swimAvgHr, sport: 'open_water_swim', distanceM: swimDistanceM, dateStr: startedAt.slice(0, 10) }).exertion +
		computeExertion({ movingSeconds: runSeconds, hasHrStream: true, avgHr: runAvgHr, sport: 'run', distanceM: runDistanceM, dateStr: startedAt.slice(0, 10) }).exertion;

	activities.push({
		key: parentKey, sport: 'other', sub_sport: 'triathlon', parentKey: null, leg: null,
		title: `${venue.name.split(',')[0]} Triathlon (Olympic)`, notes: 'Swim 1.5K / Bike 40K / Run 10K.', private_notes: null,
		started_at: startedAt, local_date: startedAt.slice(0, 10),
		utc_offset_minutes: -420, timezone: 'America/Los_Angeles',
		elapsed_seconds: Math.round(totalElapsed), moving_seconds: Math.round(totalMoving),
		distance_m: round1(totalDistance),
		elevation_gain_m: round1(bikeStats.gain + runStats.gain),
		elevation_loss_m: round1(bikeStats.loss + runStats.loss),
		elev_high_m: round1(Math.max(elevationStats(bikeTrack.elevations).high, elevationStats(runTrack.elevations).high)),
		elev_low_m: round1(Math.min(elevationStats(bikeTrack.elevations).low, elevationStats(runTrack.elevations).low)),
		avg_speed_ms: round2(totalDistance / totalMoving),
		max_speed_ms: round2(Math.max(bikeAvgPower ? bikeTrack.distanceM / bikeSeconds * 1.8 : 0, 12)),
		avg_hr: Math.round((swimAvgHr + bikeAvgHr + runAvgHr) / 3), max_hr: Math.round(runAvgHr * 1.08),
		avg_cadence: null, avg_power_w: bikeAvgPower, max_power_w: Math.round(bikeAvgPower * 1.8),
		normalized_power_w: Math.round(bikeAvgPower * 1.05), work_kj: Math.round((bikeAvgPower * bikeSeconds) / 1000),
		calories: Math.round((totalElapsed / 3600) * 700),
		avg_temp_c: 21, pool_length_m: null, total_strokes: null, avg_swolf: null,
		exertion: round1(parentExertion), exertion_method: 'tss', exertion_confidence: 'measured', intensity_factor: null,
		polyline: encodePolyline(bikeTrack.points), route_path: buildRoutePath(bikeTrack.points),
		start_lat: venue.lat, start_lng: venue.lng, end_lat: venue.lat, end_lng: venue.lng,
		bbox_w: venue.lng - 0.05, bbox_s: venue.lat - 0.05, bbox_e: venue.lng + 0.05, bbox_n: venue.lat + 0.05,
		start_place: venue.name, gearKey: null, favorite_rank: null, has_streams: false,
		device_name: pick(DEVICES),
	});
	addSource(parentKey);

	// Laps on the PARENT: the whole event broken into legs, transitions
	// included as lap_type='transition' — ACTIVITIES.md §5's "both a lap AND a
	// child activity" rule.
	lapsByKey.set(parentKey, [
		{ lap_index: 1, name: 'Swim', start_time: startedAt, elapsed_seconds: Math.round(swimSeconds), moving_seconds: Math.round(swimSeconds), distance_m: swimDistanceM, avg_hr: swimAvgHr, max_hr: Math.round(swimAvgHr * 1.1), avg_power_w: null, avg_speed_ms: round2(swimDistanceM / swimSeconds), elevation_gain_m: 0, lap_type: 'lap' },
		{ lap_index: 2, name: 'T1', start_time: t1Start, elapsed_seconds: Math.round(t1Seconds), moving_seconds: Math.round(t1Seconds), distance_m: 0, avg_hr: null, max_hr: null, avg_power_w: null, avg_speed_ms: null, elevation_gain_m: 0, lap_type: 'transition' },
		{ lap_index: 3, name: 'Bike', start_time: bikeStart, elapsed_seconds: Math.round(bikeSeconds), moving_seconds: Math.round(bikeSeconds), distance_m: round1(bikeTrack.distanceM), avg_hr: bikeAvgHr, max_hr: Math.round(bikeAvgHr * 1.12), avg_power_w: bikeAvgPower, avg_speed_ms: round2(bikeTrack.distanceM / bikeSeconds), elevation_gain_m: round1(bikeStats.gain), lap_type: 'lap' },
		{ lap_index: 4, name: 'T2', start_time: t2Start, elapsed_seconds: Math.round(t2Seconds), moving_seconds: Math.round(t2Seconds), distance_m: 0, avg_hr: null, max_hr: null, avg_power_w: null, avg_speed_ms: null, elevation_gain_m: 0, lap_type: 'transition' },
		{ lap_index: 5, name: 'Run', start_time: runStart, elapsed_seconds: Math.round(runSeconds), moving_seconds: Math.round(runSeconds), distance_m: round1(runTrack.distanceM), avg_hr: runAvgHr, max_hr: Math.round(runAvgHr * 1.08), avg_power_w: null, avg_speed_ms: round2(runTrack.distanceM / runSeconds), elevation_gain_m: round1(runStats.gain), lap_type: 'lap' },
	]);

	return { parentKey, legKeys: [swimKey, t1Key, bikeKey, t2Key, runKey] };
}

// --- walk the calendar ---
const triathlonParents = [];
for (let d = new Date(startDate); d <= today; d = addDays(d, 1)) {
	const dateStr = fmtDate(d);
	if (triathlonDates.has(dateStr)) {
		triathlonParents.push(generateTriathlon(new Date(d)));
		continue;
	}
	generateRideOrRun(new Date(d));
}

// --- favorites: four strong, varied standalone activities ---
{
	const candidates = activities.filter((a) => !a.parentKey && a.distance_m);
	const rides = candidates.filter((a) => a.sport === 'ride' || a.sport === 'gravel_ride').sort((a, b) => b.distance_m - a.distance_m);
	const hikes = candidates.filter((a) => a.sport === 'hike').sort((a, b) => (b.elevation_gain_m ?? 0) - (a.elevation_gain_m ?? 0));
	const skis = candidates.filter((a) => a.sport === 'alpine_ski').sort((a, b) => (b.elevation_loss_m ?? 0) - (a.elevation_loss_m ?? 0));
	const tris = activities.filter((a) => a.sub_sport === 'triathlon');
	const favorites = [tris[0], rides[0], hikes[0], skis[0]].filter(Boolean).slice(0, 4);
	favorites.forEach((a, i) => {
		a.favorite_rank = i + 1;
	});
}

// --- trim stream storage to a representative sample --------------------------
// Every activity still gets a plausible exertion computed from its (in-memory)
// effort profile — see pushActivity's hasPowerStream/hasHrStream, decided at
// generation time — but not every one needs its sample arrays actually
// written to activity_streams: the detail page only needs enough real
// examples to render against, not a full stream per activity. Keeps every
// favourite and both triathlons' legs (the activities most likely to be
// clicked into), then a spread of the rest, capped well below the full set.
{
	const STREAM_CAP = 30;
	const keys = [...streamsByKey.keys()];
	const byKey = new Map(activities.map((a) => [a.key, a]));
	const priority = (k) => {
		const a = byKey.get(k);
		if (a?.favorite_rank) return 0;
		if (a?.sub_sport === 'triathlon' || (a?.parentKey && byKey.get(a.parentKey)?.sub_sport === 'triathlon')) return 1;
		return 2;
	};
	const ordered = keys
		.map((k, i) => ({ k, i }))
		.sort((a, b) => priority(a.k) - priority(b.k) || a.i - b.i);
	const keep = new Set(ordered.slice(0, STREAM_CAP).map((o) => o.k));
	for (const k of keys) {
		if (!keep.has(k)) {
			streamsByKey.delete(k);
			const a = byKey.get(k);
			if (a) a.has_streams = false;
		}
	}
}

// --- gear distance totals (denormalised column, kept in sync here as the
// "on write" the schema comment describes) ---
const gearDistance = new Map();
for (const a of activities) {
	if (a.gearKey && a.distance_m) gearDistance.set(a.gearKey, (gearDistance.get(a.gearKey) ?? 0) + a.distance_m);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function printSummary() {
	const bySport = new Map();
	for (const a of activities) bySport.set(a.sport, (bySport.get(a.sport) ?? 0) + 1);
	const withGps = activities.filter((a) => a.route_path).length;
	const noGps = activities.length - withGps;
	const withStreams = activities.filter((a) => a.has_streams).length;
	const favorites = activities.filter((a) => a.favorite_rank).length;

	console.error(`\n${SEED_MARKER} — synthetic activity log`);
	console.error(`window: ${fmtDate(startDate)} .. ${fmtDate(today)}`);
	console.error(`activities: ${activities.length} (${activities.filter((a) => !a.parentKey).length} top-level, ${activities.filter((a) => a.parentKey).length} multisport legs)`);
	console.error(`triathlons: ${triathlonParents.length}`);
	console.error(`with route/gps: ${withGps}  ·  no gps: ${noGps}`);
	console.error(`with streams: ${withStreams}`);
	console.error(`favorites set: ${favorites}`);
	console.error(`gear: ${GEAR.length}  ·  thresholds: ${THRESHOLD_ROWS.length}`);
	console.error('by sport:');
	for (const [sport, n] of [...bySport.entries()].sort((a, b) => b[1] - a[1])) {
		console.error(`  ${sport.padEnd(16)} ${n}`);
	}
}
printSummary();
if (DRY) process.exit(0);

// ---------------------------------------------------------------------------
// Commit — SQL emission
// ---------------------------------------------------------------------------
function lit(v) {
	if (v == null) return 'null';
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	return `'${String(v).replace(/'/g, "''")}'`;
}
function jsonLit(v) {
	return v == null ? 'null' : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
}

function buildSql() {
	const out = [];
	out.push(`-- Generated by scripts/${SEED_MARKER} — synthetic activity history.`);
	out.push(`-- Window: ${fmtDate(startDate)} .. ${fmtDate(today)}. Idempotent via --reset (see the script header).\n`);

	if (RESET) {
		out.push('-- --reset: wipe every previously seeded row first.');
		out.push(`delete from public.activities where id in (select activity_id from public.activity_sources where provider = 'manual' and file_name = ${lit(SEED_MARKER)});`);
		out.push(`delete from public.activity_gear where external_ids ->> 'seed_marker' = ${lit(SEED_MARKER)};`);
		out.push('delete from public.athlete_thresholds; -- exclusively seeded by this script; see header\n');
	}

	// --- gear ---
	const gearId = new Map();
	GEAR.forEach((g, i) => gearId.set(g.key, i + 1));
	out.push('-- activity_gear');
	out.push('insert into public.activity_gear (id, kind, name, brand, model, nickname, distance_m, external_ids) overriding system value values');
	out.push(
		GEAR.map(
			(g) =>
				`\t(${gearId.get(g.key)}, ${lit(g.kind)}, ${lit(g.name)}, ${lit(g.brand)}, ${lit(g.model)}, ${lit(g.nickname)}, ${round1(gearDistance.get(g.key) ?? 0)}, ${jsonLit({ seed_marker: SEED_MARKER })})`,
		).join(',\n') + ';',
	);
	out.push(`select setval(pg_get_serial_sequence('public.activity_gear', 'id'), (select max(id) from public.activity_gear));\n`);

	// --- thresholds ---
	const thId = new Map();
	THRESHOLD_ROWS.forEach((t, i) => thId.set(t.key, i + 1));
	out.push('-- athlete_thresholds');
	out.push('insert into public.athlete_thresholds (id, effective_from, ftp_w, lthr_bpm, max_hr, rest_hr, threshold_pace_s_per_km, css_pace_s_per_100m, weight_kg) overriding system value values');
	out.push(
		THRESHOLD_ROWS.map(
			(t) =>
				`\t(${thId.get(t.key)}, ${lit(t.effective_from)}, ${t.ftp_w}, ${t.lthr_bpm}, ${t.max_hr}, ${t.rest_hr}, ${t.threshold_pace_s_per_km}, ${t.css_pace_s_per_100m}, ${t.weight_kg})`,
		).join(',\n') + ';',
	);
	out.push(`select setval(pg_get_serial_sequence('public.athlete_thresholds', 'id'), (select max(id) from public.athlete_thresholds));\n`);

	// --- activities (parents/standalone first, then children — parent_id FK) ---
	const parents = activities.filter((a) => !a.parentKey);
	const children = activities.filter((a) => a.parentKey);
	const cols = [
		'id', 'sport', 'sub_sport', 'parent_id', 'leg', 'title', 'notes', 'private_notes',
		'started_at', 'local_date', 'utc_offset_minutes', 'timezone', 'elapsed_seconds', 'moving_seconds',
		'distance_m', 'elevation_gain_m', 'elevation_loss_m', 'elev_high_m', 'elev_low_m',
		'avg_speed_ms', 'max_speed_ms', 'avg_hr', 'max_hr', 'avg_cadence', 'avg_power_w', 'max_power_w',
		'normalized_power_w', 'work_kj', 'calories', 'avg_temp_c', 'pool_length_m', 'total_strokes', 'avg_swolf',
		'exertion', 'exertion_method', 'exertion_confidence', 'intensity_factor', 'polyline', 'route_path',
		'start_lat', 'start_lng', 'end_lat', 'end_lng', 'bbox_w', 'bbox_s', 'bbox_e', 'bbox_n', 'start_place',
		'gear_id', 'favorite_rank', 'has_streams', 'device_name',
	];
	const rowSql = (a) => {
		const vals = {
			...a, id: a.key, parent_id: a.parentKey ?? null, gear_id: a.gearKey ? gearId.get(a.gearKey) : null,
		};
		return `\t(${cols.map((c) => lit(vals[c])).join(', ')})`;
	};
	out.push('-- activities: standalone + multisport parents');
	for (let i = 0; i < parents.length; i += 8) {
		const batch = parents.slice(i, i + 8);
		out.push(`insert into public.activities (${cols.join(', ')}) overriding system value values`);
		out.push(batch.map(rowSql).join(',\n') + ';');
	}
	if (children.length) {
		out.push('-- activities: multisport legs (parent_id now resolvable)');
		for (let i = 0; i < children.length; i += 8) {
			const batch = children.slice(i, i + 8);
			out.push(`insert into public.activities (${cols.join(', ')}) overriding system value values`);
			out.push(batch.map(rowSql).join(',\n') + ';');
		}
	}
	out.push(`select setval(pg_get_serial_sequence('public.activities', 'id'), (select max(id) from public.activities));\n`);

	// --- streams ---
	const streamRows = [...streamsByKey.entries()];
	if (streamRows.length) {
		out.push('-- activity_streams');
		const scols = ['activity_id', 'sample_count', 'time_s', 'latlng', 'altitude_m', 'distance_m', 'heartrate', 'cadence', 'power_w', 'speed_ms', 'temp_c', 'grade', 'moving'];
		for (let i = 0; i < streamRows.length; i += 4) {
			const batch = streamRows.slice(i, i + 4);
			out.push(`insert into public.activity_streams (${scols.join(', ')}) values`);
			out.push(
				batch
					.map(
						([key, s]) =>
							`\t(${key}, ${s.sample_count}, ${jsonLit(s.time_s)}, ${jsonLit(s.latlng)}, ${jsonLit(s.altitude_m)}, ${jsonLit(s.distance_m)}, ${jsonLit(s.heartrate)}, ${jsonLit(s.cadence)}, ${jsonLit(s.power_w)}, ${jsonLit(s.speed_ms)}, ${jsonLit(s.temp_c)}, ${jsonLit(s.grade)}, ${jsonLit(s.moving)})`,
					)
					.join(',\n') + ';',
			);
		}
		out.push('');
	}

	// --- laps ---
	const lapRows = [...lapsByKey.entries()].flatMap(([key, laps]) => laps.map((l) => ({ ...l, activity_id: key })));
	if (lapRows.length) {
		out.push('-- activity_laps');
		const lcols = ['activity_id', 'lap_index', 'name', 'start_time', 'elapsed_seconds', 'moving_seconds', 'distance_m', 'avg_hr', 'max_hr', 'avg_power_w', 'avg_speed_ms', 'elevation_gain_m', 'lap_type'];
		for (let i = 0; i < lapRows.length; i += 20) {
			const batch = lapRows.slice(i, i + 20);
			out.push(`insert into public.activity_laps (${lcols.join(', ')}) values`);
			out.push(batch.map((l) => `\t(${lcols.map((c) => lit(l[c])).join(', ')})`).join(',\n') + ';');
		}
		out.push('');
	}

	// --- sources ---
	const sourceRows = [...sourceByKey.entries()];
	out.push('-- activity_sources — the idempotency marker every seeded activity carries');
	const srccols = ['activity_id', 'provider', 'external_id', 'external_url', 'file_name', 'file_checksum', 'fidelity', 'raw', 'imported_at'];
	for (let i = 0; i < sourceRows.length; i += 20) {
		const batch = sourceRows.slice(i, i + 20);
		out.push(`insert into public.activity_sources (${srccols.join(', ')}) values`);
		out.push(
			batch
				.map(
					([key, s]) =>
						`\t(${key}, ${lit(s.provider)}, ${lit(s.external_id)}, ${lit(s.external_url)}, ${lit(s.file_name)}, ${lit(s.file_checksum)}, ${s.fidelity}, ${jsonLit(s.raw)}, ${lit(s.imported_at)})`,
				)
				.join(',\n') + ';',
		);
	}

	return out.join('\n');
}

if (SQL_ONLY) {
	console.log(buildSql());
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Commit — live insert via supabase-js
// ---------------------------------------------------------------------------
async function insertOne(table, row) {
	const { data, error } = await db.from(table).insert(row).select('id').single();
	if (error) throw new Error(`insert ${table} failed: ${error.message}`);
	return data.id;
}

async function commitLive() {
	if (RESET) {
		console.error('resetting previously seeded rows...');
		const { data: toDelete, error: findErr } = await db
			.from('activity_sources')
			.select('activity_id')
			.eq('provider', 'manual')
			.eq('file_name', SEED_MARKER);
		if (findErr) throw new Error(`reset lookup failed: ${findErr.message}`);
		const ids = [...new Set((toDelete ?? []).map((r) => r.activity_id))];
		if (ids.length) {
			const { error } = await db.from('activities').delete().in('id', ids);
			if (error) throw new Error(`reset delete activities failed: ${error.message}`);
		}
		await db.from('activity_gear').delete().eq('external_ids->>seed_marker', SEED_MARKER);
		await db.from('athlete_thresholds').delete().neq('id', -1);
		console.error(`  removed ${ids.length} activities and their gear/thresholds.`);
	}

	console.error('inserting gear...');
	const gearRealId = new Map();
	for (const g of GEAR) {
		const id = await insertOne('activity_gear', {
			kind: g.kind, name: g.name, brand: g.brand, model: g.model, nickname: g.nickname,
			distance_m: round1(gearDistance.get(g.key) ?? 0),
			external_ids: { seed_marker: SEED_MARKER },
		});
		gearRealId.set(g.key, id);
	}

	console.error('inserting thresholds...');
	for (const t of THRESHOLD_ROWS) {
		await db.from('athlete_thresholds').insert({
			effective_from: t.effective_from, ftp_w: t.ftp_w, lthr_bpm: t.lthr_bpm, max_hr: t.max_hr,
			rest_hr: t.rest_hr, threshold_pace_s_per_km: t.threshold_pace_s_per_km,
			css_pace_s_per_100m: t.css_pace_s_per_100m, weight_kg: t.weight_kg,
		});
	}

	console.error(`inserting ${activities.length} activities (this takes a bit — one round trip each)...`);
	const realId = new Map();
	const parents = activities.filter((a) => !a.parentKey);
	const children = activities.filter((a) => a.parentKey);
	const { key: _k1, gearKey: _g1, parentKey: _p1, ...cols0 } = parents[0] ?? {};
	const activityCols = (a) => {
		const { key, gearKey, parentKey, ...rest } = a;
		return { ...rest, gear_id: gearKey ? gearRealId.get(gearKey) : null, parent_id: null };
	};
	let n = 0;
	for (const a of parents) {
		const id = await insertOne('activities', activityCols(a));
		realId.set(a.key, id);
		if (++n % 25 === 0) console.error(`  ${n}/${activities.length}`);
	}
	for (const a of children) {
		const row = { ...activityCols(a), parent_id: realId.get(a.parentKey) };
		const id = await insertOne('activities', row);
		realId.set(a.key, id);
		if (++n % 25 === 0) console.error(`  ${n}/${activities.length}`);
	}

	console.error('inserting streams/laps/sources...');
	for (const [key, s] of streamsByKey) {
		const { error } = await db.from('activity_streams').insert({ activity_id: realId.get(key), ...s });
		if (error) throw new Error(`insert activity_streams failed: ${error.message}`);
	}
	for (const [key, laps] of lapsByKey) {
		const { error } = await db.from('activity_laps').insert(laps.map((l) => ({ ...l, activity_id: realId.get(key) })));
		if (error) throw new Error(`insert activity_laps failed: ${error.message}`);
	}
	for (const [key, s] of sourceByKey) {
		const { error } = await db.from('activity_sources').insert({ ...s, activity_id: realId.get(key) });
		if (error) throw new Error(`insert activity_sources failed: ${error.message}`);
	}

	console.error(`\ndone. inserted ${activities.length} activities, ${streamsByKey.size} stream rows, ${[...lapsByKey.values()].reduce((s, l) => s + l.length, 0)} laps, ${GEAR.length} gear, ${THRESHOLD_ROWS.length} thresholds.`);
}

await commitLive();
