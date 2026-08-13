// Presentation helpers for the restaurant log — the decisions that would
// otherwise be repeated across eight pages, and the two that are load-bearing
// enough to deserve their reasoning written down.
import { photoUrl } from './restaurants';
import { daysInMonth, firstWeekdayIndex, parseMonthKey } from './share-card';
import type { DiaryVisit, Photo, Place, PriceBand, VisitDetail } from './restaurants';

/**
 * How a place is located, at whatever granularity it has.
 *
 * "Sunset Park, Brooklyn" when there's a neighbourhood, "Austin, TX" when there
 * isn't. The fallback must not read as a missing field — an absent
 * neighbourhood is the level of detail that place warrants, and geocoders are
 * unreliable about neighbourhoods outside New York anyway.
 */
export function placeLine(place: {
	neighborhood: string | null;
	city: string;
	state_region: string | null;
	country: string;
}): string {
	if (place.neighborhood) return `${place.neighborhood}, ${place.city}`;
	if (place.state_region) return `${place.city}, ${place.state_region}`;
	return place.city;
}

/** "Mexican, Sonoran" — every cuisine, in the order they were entered. */
export function cuisineLine(cuisines: string[]): string {
	return cuisines.join(', ');
}

/**
 * The cuisine a tile can afford when there is room for one word.
 *
 * A place carries up to three cuisines and a tile is 198px wide. The first is
 * the one that was typed first, which is reliably the one that names the place.
 */
export function primaryCuisine(cuisines: string[]): string {
	return cuisines[0] ?? '';
}

// ---------------------------------------------------------------------------
// The tile
// ---------------------------------------------------------------------------

/**
 * WHAT THE TILE IS, GIVEN THERE ARE NO POSTERS.
 *
 * The film log's density is free: someone else drew the poster, it is always
 * there, and it is always 2:3. A restaurant has no canonical image. It has my
 * own photographs — which exist only after I've been, are wildly inconsistent,
 * and are entirely absent for anything on the to-try list — and it has a name,
 * a cuisine, a price and a place, which are short strings.
 *
 * So the tile is TYPOGRAPHIC, and the photograph is a bonus rather than the
 * substrate. Every tile has the same anatomy:
 *
 *     ┌───────────────────┐
 *     │  head             │  a photograph if there is one, otherwise the price
 *     │                   │  band set large on ruled paper with the cuisine
 *     ├───────────────────┤  under it in small caps — a menu's price column,
 *     │ Name           ♥  │  blown up to fill the slot a poster would have
 *     │ Cuisine ····· $$  │
 *     │ ◑ Neighbourhood   │
 *     └───────────────────┘
 *
 * The head is a fixed height, so a photo tile and a no-photo tile occupy the
 * same slot and a row of four never goes ragged. That is the whole trick: the
 * fallback is not an empty state, it is the same tile with its price set big.
 */
/**
 * The photograph a place's tile uses, or null — in which case the tile draws
 * its price band on ruled paper instead, at the same height.
 *
 * A place's cover is the most recent photo taken there (picked in the
 * `restaurant_places` view), which keeps the landing page moving as you eat
 * rather than freezing on whatever you shot the first time.
 */
export function coverUrl(place: Place): string | null {
	return place.cover_path ? photoUrl(place.cover_path) : null;
}

// ---------------------------------------------------------------------------
// Photographs
// ---------------------------------------------------------------------------

/**
 * How a visit's photographs are laid out.
 *
 * The constraints, in the order they bite: there are usually zero, which must
 * not look like a failure; the commonest non-zero case is one; orientations mix
 * inside a single entry, so a grid that assumes 4:3 is wrong most of the time;
 * and captions are the exception, so nothing may reserve room for one.
 *
 * The answer is a row-based flex layout where each photo's basis is its own
 * aspect ratio at a shared height. Portraits come out narrow, landscapes wide,
 * everything sits on one baseline, and the last row is allowed to be short
 * rather than stretched. One photo simply fills the width at its own ratio.
 */
export interface LaidOutPhoto extends Photo {
	/** Aspect ratio, defaulting to 3:2 when the dimensions were never recorded. */
	ratio: number;
	/** flex-grow weight — wide photos claim proportionally more of the row. */
	grow: number;
}

export function layoutPhotos(photos: Photo[]): LaidOutPhoto[] {
	return photos.map((p) => {
		const ratio = p.width && p.height ? p.width / p.height : 3 / 2;
		return { ...p, ratio, grow: ratio };
	});
}

/**
 * Photographs on a place page, grouped by the visit that produced them.
 *
 * Aggregating eleven visits' photos into one undifferentiated wall loses the
 * only thing that makes them navigable — when. Grouped by date, the same wall
 * reads as a history, and the group heading is where the count goes.
 */
export interface PhotoGroup {
	visitId: number;
	date: string;
	photos: LaidOutPhoto[];
}

export function groupPhotosByVisit(visits: VisitDetail[]): PhotoGroup[] {
	return visits
		.filter((v) => v.photos.length > 0)
		.map((v) => ({ visitId: v.id, date: v.visited_on, photos: layoutPhotos(v.photos) }));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "2026-08-08" → "8 Aug". Parsed as a local date so it can't slip a day. */
export function shortDate(iso: string): string {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
	if (!y || !m || !d) return iso;
	return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * "2026-08-08" → "Saturday 8 August 2026".
 *
 * Composed rather than handed to one `toLocaleDateString` call, because every
 * locale that gives the weekday also inserts a comma after it, and the entry
 * page sets this line in letter-spaced uppercase where a comma reads as grit.
 */
export function longDate(iso: string): string {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
	if (!y || !m || !d) return iso;
	const date = new Date(y, m - 1, d);
	const weekday = date.toLocaleDateString('en-GB', { weekday: 'long' });
	const month = date.toLocaleDateString('en-GB', { month: 'long' });
	return `${weekday} ${d} ${month} ${y}`;
}

/** "11 visits", "1 visit", "not been yet". */
export function visitCountLabel(n: number): string {
	if (n === 0) return 'not been yet';
	return n === 1 ? '1 visit' : `${n} visits`;
}

/** The marks that ride alongside a rating: heart, then the revisit arrow. */
export function visitMarks(visit: { hearted: boolean; revisit: boolean }): string {
	return [visit.hearted ? '♥' : '', visit.revisit ? '↻' : ''].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// The month card
// ---------------------------------------------------------------------------

export interface MonthFigure {
	value: string;
	label: string;
}

/**
 * The four figures on the shareable month card.
 *
 * The film and book versions both count things there are a lot of. A good month
 * of eating is eight meals, so counting harder does not help; these are chosen
 * to say something at that scale — how much I went out, how much of it was new,
 * how good it was, and what it cost.
 */
export function monthFigures(visits: DiaryVisit[], newPlaceIds: Set<number>): MonthFigure[] {
	const rated = visits.filter((v) => v.rating != null).map((v) => v.rating as number);
	const avg = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
	return [
		{ value: String(visits.length), label: visits.length === 1 ? 'meal out' : 'meals out' },
		{ value: String(newPlaceIds.size), label: newPlaceIds.size === 1 ? 'new place' : 'new places' },
		{ value: avg == null ? '—' : avg.toFixed(1), label: 'avg rating' },
		{ value: medianPrice(visits) ?? '—', label: 'median price' },
	];
}

function medianPrice(visits: { price_band: PriceBand | null }[]): string | null {
	const bands = visits
		.map((v) => v.price_band)
		.filter((b): b is PriceBand => b != null)
		.map((b) => b.length)
		.sort((a, b) => a - b);
	if (bands.length === 0) return null;
	// Lower of the two middles on an even count: the cheaper reading is the
	// honest one when a month straddles two bands.
	const middle = bands[Math.floor((bands.length - 1) / 2)];
	return '$'.repeat(middle);
}

/** Calendar cells for a month card, Monday-first, padded to whole weeks. */
export interface CalendarCell {
	day: number | null;
	/** The best verdict recorded that day, or null when nothing was logged. */
	verdict: number | null;
	visitId: number | null;
}

export function monthCalendar(monthKey: string, visits: DiaryVisit[]): CalendarCell[] {
	const parsed = parseMonthKey(monthKey);
	if (!parsed) return [];
	const { year, month } = parsed;
	// Arithmetic, not Dates — same rule the other two month cards follow, so a
	// runtime in UTC can't shift which column the 1st lands in.
	const days = daysInMonth(year, month);
	const lead = firstWeekdayIndex(year, month);

	const byDay = new Map<number, DiaryVisit[]>();
	for (const v of visits) {
		const day = Number(v.visited_on.slice(8, 10));
		byDay.set(day, [...(byDay.get(day) ?? []), v]);
	}

	const cells: CalendarCell[] = [];
	for (let i = 0; i < lead; i++) cells.push({ day: null, verdict: null, visitId: null });
	for (let day = 1; day <= days; day++) {
		const hits = byDay.get(day) ?? [];
		const best = hits.reduce<number | null>(
			(min, v) => (v.verdict != null && (min == null || v.verdict < min) ? v.verdict : min),
			null,
		);
		cells.push({ day, verdict: best, visitId: hits[0]?.id ?? null });
	}
	while (cells.length % 7 !== 0) cells.push({ day: null, verdict: null, visitId: null });
	return cells;
}
