// The map — projection, framing and clustering, computed on the server.
//
// WHY THERE IS NO MAP LIBRARY HERE. The rest of this site draws its own
// graphics: the subway page projects the MTA's schematic into an SVG by hand
// and the film log's charts are divs. A pin plot over a city is the same
// problem, and it is the only kind of map this section needs — the pins are the
// content and a basemap would be scenery behind them. So this projects to Web
// Mercator, frames the result, clusters what overlaps, and hands the page plain
// percentages. Nothing to load, nothing to key, and it renders in the section's
// own palette rather than in a vendor's.
//
// WHAT HAPPENS ON FIRST LOAD. Fitting the bounds of the whole collection is the
// obvious answer and it is the wrong one: four fifths of the pins are one dense
// New York cluster and the rest are in Mexico City, Austin, LA and Tokyo, so
// fit-to-bounds produces a world map with five specks on it. Defaulting to New
// York silently hides a fifth of the collection instead.
//
// So the map opens on the LARGEST city and says so, with every other city
// listed beside it and its count — which is both the affordance that tells you
// the rest of the world is there and the control that takes you to it. The
// list is ordered by how much of the collection each city holds, so the thing
// you are missing is legible before you click anything.

export interface MapPoint {
	id: number;
	name: string;
	lat: number;
	lng: number;
	verdict: number | null;
	/** A place you've been, or one on the to-try list. Drawn differently. */
	visited: boolean;
	price: string | null;
	cuisine: string;
	/** The city, matched exactly by the switcher. */
	city: string;
	/** "Sunset Park, Brooklyn" — what the popup shows. */
	where: string;
	rating: number | null;
	visits: number;
	hearted: boolean;
}

/** A point placed in the viewport, as percentages of its box. */
export interface PlottedPin extends MapPoint {
	x: number;
	y: number;
}

export interface Cluster {
	x: number;
	y: number;
	count: number;
	/** Best verdict in the cluster, for the badge's ink. */
	verdict: number | null;
	/** The verdict mix, as fractions, for the bar under the badge. */
	mix: { ink: string; fraction: number }[];
	names: string[];
}

export interface Frame {
	/** Degrees of longitude across the frame. Smaller is closer in. */
	spanLng: number;
	centerLat: number;
	centerLng: number;
}

const MERCATOR_LIMIT = 85.05112878;

/** Web Mercator y, normalised to 0–1 from the north pole down. */
function mercatorY(lat: number): number {
	const clamped = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
	const rad = (clamped * Math.PI) / 180;
	return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/**
 * A frame around some points: their centre, and a span with enough air that no
 * pin sits on the edge. Padded to a floor so a single point — or twelve
 * restaurants on eight blocks — doesn't zoom to street level and lose all
 * context.
 */
export function frameFor(points: MapPoint[], aspect = 900 / 560): Frame {
	if (points.length === 0) return { spanLng: 0.08, centerLat: 40.7128, centerLng: -74.006 };

	const lats = points.map((p) => p.lat);
	const lngs = points.map((p) => p.lng);
	const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
	const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

	const spreadLng = Math.max(...lngs) - Math.min(...lngs);
	// Latitude spread is measured in Mercator space and converted back, so the
	// frame is right at Tokyo's latitude as well as Mexico City's.
	const spreadY = mercatorY(Math.min(...lats)) - mercatorY(Math.max(...lats));
	const spreadLngFromY = spreadY * 360 * aspect;

	const span = Math.max(spreadLng, spreadLngFromY, 0.02) * 1.35;
	return { spanLng: span, centerLat, centerLng };
}

/** Project points into a frame, as x/y percentages. Points outside are dropped. */
export function plot(points: MapPoint[], frame: Frame, aspect = 900 / 560): PlottedPin[] {
	const spanY = frame.spanLng / 360 / aspect;
	const centerY = mercatorY(frame.centerLat);

	const pins: PlottedPin[] = [];
	for (const p of points) {
		const x = (p.lng - frame.centerLng) / frame.spanLng + 0.5;
		const y = (mercatorY(p.lat) - centerY) / spanY + 0.5;
		if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) continue;
		pins.push({ ...p, x: x * 100, y: y * 100 });
	}
	return pins;
}

/**
 * Collapse pins that would overlap into cluster badges.
 *
 * Twelve restaurants on eight blocks of Sunset Park land within a few pixels of
 * each other at city zoom, and twelve overlapping pins is worse than no pins.
 * A cluster badge carries its count and a strip of the verdict mix underneath —
 * so a cluster of twelve reads as "twelve, mostly places I'd go back to"
 * without being expanded, which is the question you were going to ask anyway.
 *
 * `radius` is in percent of the box's width, so it scales with the viewport
 * rather than assuming a pixel size.
 */
export function cluster(
	pins: PlottedPin[],
	inkFor: (verdict: number | null) => string,
	radius = 3.2,
): { pins: PlottedPin[]; clusters: Cluster[] } {
	const taken = new Set<number>();
	const loose: PlottedPin[] = [];
	const clusters: Cluster[] = [];

	for (let i = 0; i < pins.length; i++) {
		if (taken.has(i)) continue;
		const group = [pins[i]];
		taken.add(i);
		for (let j = i + 1; j < pins.length; j++) {
			if (taken.has(j)) continue;
			const dx = pins[j].x - pins[i].x;
			const dy = pins[j].y - pins[i].y;
			if (Math.hypot(dx, dy) <= radius) {
				group.push(pins[j]);
				taken.add(j);
			}
		}
		if (group.length === 1) {
			loose.push(group[0]);
			continue;
		}
		const counts = new Map<string, number>();
		for (const g of group) {
			const ink = inkFor(g.verdict);
			counts.set(ink, (counts.get(ink) ?? 0) + 1);
		}
		clusters.push({
			x: group.reduce((s, g) => s + g.x, 0) / group.length,
			y: group.reduce((s, g) => s + g.y, 0) / group.length,
			count: group.length,
			verdict: group.reduce<number | null>(
				(best, g) => (g.verdict != null && (best == null || g.verdict < best) ? g.verdict : best),
				null,
			),
			mix: [...counts.entries()].map(([ink, n]) => ({ ink, fraction: n / group.length })),
			names: group.map((g) => g.name),
		});
	}

	return { pins: loose, clusters };
}
