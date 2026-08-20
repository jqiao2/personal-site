// Presentation helpers for the restaurant log — the decisions that would
// otherwise be repeated across eight pages, and the two that are load-bearing
// enough to deserve their reasoning written down.
import { cuisineTerms, photoUrl } from './restaurants';
import { daysInMonth, firstWeekdayIndex, parseMonthKey } from './share-card';
import type { DiaryVisit, Photo, Place, VisitDetail } from './restaurants';

/**
 * How a place is located, at whatever granularity it has.
 *
 * "Sunset Park, Brooklyn" when there's a neighbourhood, "Austin, TX" when there
 * isn't. The fallback must not read as a missing field — an absent
 * neighbourhood is the level of detail that place warrants, and geocoders are
 * unreliable about neighbourhoods outside New York anyway.
 *
 * THE BOROUGH IS THE SECOND WORD WHERE THERE IS ONE, and that is the whole
 * reason it got a column. "Sunset Park, Brooklyn" is what this line has always
 * claimed to render, but `city` for anywhere in the five boroughs is
 * "New York" — so until the borough was stored the line either said
 * "Sunset Park, New York" or leaned on somebody having typed the borough into
 * the city box by hand. Optional, because the diary and the tiles hand this
 * whatever they have and a caller without a borough should keep today's answer.
 */
export function placeLine(place: {
	neighborhood: string | null;
	borough?: string | null;
	city: string;
	state_region: string | null;
	country: string;
}): string {
	if (place.neighborhood) return `${place.neighborhood}, ${place.borough ?? place.city}`;
	if (place.borough) return `${place.borough}, ${place.city}`;
	if (place.state_region) return `${place.city}, ${place.state_region}`;
	return place.city;
}

/** "Mexican, Sonoran" — every cuisine, in the order they were entered. */
export function cuisineLine(cuisines: string[]): string {
	return cuisines.join(', ');
}

// ---------------------------------------------------------------------------
// How well a place is located
// ---------------------------------------------------------------------------

/**
 * Three states, and the page reads differently in each.
 *
 *   placed    — it has coordinates. The map can draw it; the location line is
 *               a fact confirmed by whoever pinned it.
 *   located   — no coordinates, but the words are real: a neighbourhood or a
 *               state/region is on record, which only gets there by being
 *               typed in or read off a geocode. The map still has nothing to
 *               draw.
 *   unplaced  — no coordinates and no location text beyond the bare city.
 *
 * WHY THE LAST TWO ARE TOLD APART BY `neighborhood`/`state_region` AND NOT BY A
 * FLAG. `city` is NOT NULL and the composer's fast path — a name and nothing
 * else — has to stay open, so `createPlace` writes "New York" when nothing
 * better is known. That default is indistinguishable from a confirmed city if
 * you look only at `city`, which is exactly why the bulk to-try importer has
 * left 34 pages quietly asserting a city nobody chose.
 *
 * What IS distinguishable: a place that has been located, by any route, comes
 * away with a neighbourhood or a region, because both the geocoder and the
 * by-hand form write one. So their absence, together with no point, is the
 * honest signal that nothing about this location was ever confirmed — and it
 * flips the moment anything is, without a migration or a provenance column to
 * keep in sync.
 */
export type LocationState = 'placed' | 'located' | 'unplaced';

export function locationState(place: {
	neighborhood: string | null;
	state_region: string | null;
	lat: number | null;
	lng: number | null;
}): LocationState {
	if (place.lat != null && place.lng != null) return 'placed';
	if (place.neighborhood || place.state_region) return 'located';
	return 'unplaced';
}

/**
 * The line of evidence shown under an invitation to place somewhere.
 *
 * It is the record as it stands, not a story about it: when the place was
 * added, and the name it was added under. The site does not record HOW a row
 * arrived — bulk import, composer, by hand — so this says nothing about that.
 */
export function placeEvidence(place: {
	name: string;
	created_at: string;
	to_try_added_at: string | null;
}): string {
	const added = (place.to_try_added_at ?? place.created_at).slice(0, 10);
	return `added ${shortDate(added)} ${added.slice(0, 4)} · added by name · “${place.name}”`;
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
 *
 * The ratio is all this needs to hand over: the wall derives both the basis and
 * the grow weight from it in CSS, which is also how the phone can re-scale the
 * whole row against the viewport without a second set of numbers computed here.
 */
export interface LaidOutPhoto extends Photo {
	/** Aspect ratio, defaulting to 3:2 when the dimensions were never recorded. */
	ratio: number;
}

/** Aspect ratio, or 3:2 when the dimensions were never recorded. */
function aspect(photo: Photo): number {
	return photo.width && photo.height ? photo.width / photo.height : 3 / 2;
}

export function layoutPhotos(photos: Photo[]): LaidOutPhoto[] {
	return photos.map((p) => ({ ...p, ratio: aspect(p) }));
}

/**
 * Every photograph taken at a place, in one strip.
 *
 * THIS USED TO BE GROUPED BY VISIT, with a dated heading over each group. That
 * reads well at three visits and collapses at twelve: twelve headings, twelve
 * walls of one-to-three photographs each, and a page whose middle third is a
 * ragged column of near-empty rows. The grouping was buying navigability —
 * knowing WHEN a photo was taken — at the price of the section's whole shape.
 *
 * A single row buys the same thing back for nothing. The date is on the photo
 * rather than over it: point at one and it says when it was and what it was, so
 * nothing has to be spent on a heading per visit. The section is then a fixed
 * height no matter how many times I go back — twelve visits and forty look the
 * same from the page's point of view, which is the only way this section
 * survives the twentieth.
 *
 * ORDER IS OLDEST FIRST, left to right, and the row OPENS AT ITS RIGHT-HAND END.
 *
 * Those are two different questions and the page was answering them with one
 * answer. Which way time runs is settled by the verdict history above: it is a
 * plot with a time axis, and a time axis that runs right to left is a chart
 * nobody can read. Running the photographs the other way to put the newest on
 * the left made one screen disagree with itself about which way the year goes.
 *
 * What actually wanted solving was where the row STARTS, which is a scroll
 * position rather than an order, and it is solved as one — the scrollport opens
 * at the end. So time runs the way it runs everywhere, and what you land on is
 * still the last few meals.
 */
export interface StripPhoto extends LaidOutPhoto {
	/** The visit that produced it — where the photograph links to. */
	visitId: number;
	/** That visit's date, ISO. */
	date: string;
}

export function photoStrip(visits: VisitDetail[]): StripPhoto[] {
	// `visits` arrives newest first, so it is turned around here; photographs keep
	// their order within a visit.
	return visits
		.filter((v) => v.photos.length > 0)
		.slice()
		.reverse()
		.flatMap((v) => v.photos.map((p) => ({ ...p, ratio: aspect(p), visitId: v.id, date: v.visited_on })));
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
 * The three figures on the shareable month card.
 *
 * The film and book versions both count things there are a lot of. A good month
 * of eating is eight meals, so counting harder does not help; these are chosen
 * to say something at that scale — how much of the month was new, how wide it
 * ranged, and how good it was.
 *
 * How MUCH I went out is deliberately not here: the meal count is set large at
 * the top of the card, and a figure that repeats it spends a third of this row
 * saying nothing.
 */
export function monthFigures(visits: DiaryVisit[], newPlaceIds: Set<number>): MonthFigure[] {
	const rated = visits.filter((v) => v.rating != null).map((v) => v.rating as number);
	const avg = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
	// Case-folded, and split on the commas some rows stored a whole line under,
	// so "Thai" and "thai" are one cuisine and "Vietnamese, Sandwich" is two.
	const cuisines = new Set(
		visits.flatMap((v) => cuisineTerms(v.cuisines)).map((c) => c.toLowerCase()),
	);
	return [
		{ value: String(newPlaceIds.size), label: newPlaceIds.size === 1 ? 'new place' : 'new places' },
		{ value: String(cuisines.size), label: cuisines.size === 1 ? 'cuisine' : 'cuisines' },
		{ value: avg == null ? '—' : avg.toFixed(1), label: 'avg rating' },
	];
}

/**
 * What fills a calendar cell: one cover per MEAL.
 *
 * Every visit gets its own, so going back somewhere in the same month shows up
 * as two dinners rather than as one place mentioned twice — the calendar is a
 * record of meals and each meal is a day of its own. A visit contributes its
 * FIRST photograph only; the rest of that night's roll belongs on the entry
 * page, not in a 131px square.
 *
 * A MEAL I DIDN'T PHOTOGRAPH IS STILL A MEAL, and leaving it as ruled paper made
 * the card read as though nothing happened. So it falls back to a map of where
 * it happened, close enough in to show the street — which is the other thing the
 * log knows about a place, and the one that says "here" when there's no picture
 * of "what". Somewhere never pinned has neither, and keeps the paper.
 *
 * A map cover carries only the point. What it looks like is settled on the
 * client, by the same MapLibre and the same authored style the section's live
 * map uses — see the card page's script, and why it can't be a picture the
 * server asks MapTiler for.
 *
 * The ranking — rating first, verdict as the tiebreaker, since the verdict is
 * the finer judgement of the two and the one that survives a month of
 * everything landing on a 7 — decides which cover sits on top when two meals
 * share a day.
 */
export type Cover = { kind: 'photo'; url: string } & CoverMeta;
export type MapCover = { kind: 'map'; at: MapPoint } & CoverMeta;
export type AnyCover = Cover | MapCover;

interface CoverMeta {
	/** Position in the month's ranking, 0 = best. Drives the stacking order. */
	rank: number;
	visitId: number;
	restaurantId: number;
	restaurantName: string;
}

/** A point on the earth, which is all a map cover needs to be drawn from. */
export interface MapPoint {
	lat: number;
	lng: number;
}

/** Where the covers come from, for the sources the view layer can't reach. */
export interface CoverSources {
	/** Place id → where it is, for meals with no photograph. */
	maps?: Map<number, MapPoint>;
}

/** Best first: rating, then verdict, then the earlier meal. */
function byRank(a: VisitDetail, b: VisitDetail): number {
	const rating = (b.rating ?? -1) - (a.rating ?? -1);
	if (rating !== 0) return rating;
	// Verdicts are ranks, 0 (definitely return) best — so this one sorts up.
	const verdict = (a.verdict ?? Number.MAX_SAFE_INTEGER) - (b.verdict ?? Number.MAX_SAFE_INTEGER);
	if (verdict !== 0) return verdict;
	return a.visited_on < b.visited_on ? -1 : a.visited_on > b.visited_on ? 1 : a.id - b.id;
}

/**
 * The month's covers by day, each day's best-ranked first.
 *
 * Ranking is done over every visit rather than over the ones that have a
 * photograph, so a meal's place in the month doesn't depend on whether I got my
 * phone out — the ranks stay the ranks, and the covers fall where they fall.
 */
export function monthCovers(
	visits: VisitDetail[],
	{ maps }: CoverSources = {},
): Map<number, AnyCover[]> {
	const byDay = new Map<number, AnyCover[]>();
	[...visits].sort(byRank).forEach((v, rank) => {
		const photo = v.photos[0]?.url;
		const map = maps?.get(v.restaurant_id);
		if (!photo && !map) return;
		const meta: CoverMeta = {
			rank,
			visitId: v.id,
			restaurantId: v.restaurant_id,
			restaurantName: v.restaurant_name,
		};
		const cover: AnyCover = photo
			? { kind: 'photo', url: photo, ...meta }
			: { kind: 'map', at: map as MapPoint, ...meta };
		const day = Number(v.visited_on.slice(8, 10));
		byDay.set(day, [...(byDay.get(day) ?? []), cover]);
	});
	return byDay;
}

/** Calendar cells for a month card, Monday-first, padded to whole weeks. */
export interface CalendarCell {
	day: number | null;
	/** The best verdict recorded that day, or null when nothing was logged. */
	verdict: number | null;
	visitId: number | null;
	/** What to print in the cell, best-ranked first. */
	covers: AnyCover[];
}

export function monthCalendar(
	monthKey: string,
	visits: VisitDetail[],
	sources: CoverSources = {},
): CalendarCell[] {
	const parsed = parseMonthKey(monthKey);
	if (!parsed) return [];
	const { year, month } = parsed;
	// Arithmetic, not Dates — same rule the other two month cards follow, so a
	// runtime in UTC can't shift which column the 1st lands in.
	const days = daysInMonth(year, month);
	const lead = firstWeekdayIndex(year, month);
	const covers = monthCovers(visits, sources);
	const pad = (): CalendarCell => ({ day: null, verdict: null, visitId: null, covers: [] });

	const byDay = new Map<number, VisitDetail[]>();
	for (const v of visits) {
		const day = Number(v.visited_on.slice(8, 10));
		byDay.set(day, [...(byDay.get(day) ?? []), v]);
	}

	const cells: CalendarCell[] = [];
	for (let i = 0; i < lead; i++) cells.push(pad());
	for (let day = 1; day <= days; day++) {
		const hits = byDay.get(day) ?? [];
		const best = hits.reduce<number | null>(
			(min, v) => (v.verdict != null && (min == null || v.verdict < min) ? v.verdict : min),
			null,
		);
		cells.push({
			day,
			verdict: best,
			visitId: hits[0]?.id ?? null,
			covers: covers.get(day) ?? [],
		});
	}
	while (cells.length % 7 !== 0) cells.push(pad());
	return cells;
}
