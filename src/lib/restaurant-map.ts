// What the map is given.
//
// The projection and framing that used to live here are MapLibre's now (see
// src/components/RestaurantMap.astro and src/lib/map-style.ts) — it does
// fitBounds natively, and doing it by hand alongside it would have been two
// answers to one question. What survives is the shape of a point and the
// reasoning about what goes on one, because that is a decision about this
// section rather than about a renderer.
//
// THE PIN CARRIES THE TRIP ANSWER, and only that. It used to carry the return
// verdict across three colour bands, which asked the map to hold a six-rung
// ladder at 26px — and the verdict is the wrong question for a map anyway: it
// answers "would I come back", which needs the visit to have happened, and
// half the pins here are places nobody has been to yet. "Would I go out of my
// way for this" is the question you ask while looking at a map, every pin can
// answer it, and it has two states, which is what a mark this size can hold.
// Filled means worth the trip; blank means not. Stars, hearts and the verdict
// stay behind on the list and the entry, where there is room to read them.
//
// NOTHING IS CLUSTERED. A screen-space cluster used to collapse pins closer
// than 34px into a disc, which at neighbourhood zoom meant most of the New
// York map was discs rather than places — the count is the one thing you
// already know from the caption, and it hid the individual places that are the
// content. Overlapping pins are the accepted cost: a pin under another pin is
// still one hover away, and zooming in separates them.
//
// WHAT HAPPENS ON FIRST LOAD is settled here rather than in the component that
// obeys it: the map frames the city holding the most of the collection, never
// the bounds of everything. Four fifths of these pins are one dense New York
// cluster and the rest are scattered across Mexico City, Austin, LA and Tokyo,
// so fit-to-bounds is a world map with five specks on it — and defaulting to
// New York would silently hide a fifth of the collection instead.
//
// THAT FRAME IS NOT A FILTER. A city panel beside the map used to narrow the
// pins to one city at a time, which made the map show less than the list it
// was a view of. Every placed point goes on now and the camera decides what
// is legible: the opening frame is the densest city, the caption names it, and
// Tokyo is a drag away rather than a click on a list. `city` survives on the
// point because the framing still counts by it.

export interface MapPoint {
	id: number;
	name: string;
	lat: number;
	lng: number;
	/** Null for a place on the to-try list. Read on the popup, not on the pin. */
	verdict: number | null;
	/** A place you've been, or one you mean to go to. */
	visited: boolean;
	/** Worth going out of your way for. The only thing the pin itself says. */
	trip: boolean;
	price: string | null;
	cuisine: string;
	/** The city, matched exactly by the switcher and by the framing. */
	city: string;
	/** "Sunset Park, Brooklyn" — what the popup shows. */
	where: string;
	rating: number | null;
	visits: number;
	hearted: boolean;
}
