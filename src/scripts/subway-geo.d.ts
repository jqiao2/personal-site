// Types for the auto-generated subway-geo.js (scripts/generate-subway-geo.mjs).

/**
 * Segment id → its real track as [lon, lat][] and `o`, its slot among the
 * services sharing that stretch. Phantom schematic links have no entry.
 */
export declare const LINES: Record<string, { o: number; c: [number, number][] }>;

/** One marker per platform a station's services use; `id` is the station id, `n` the services there. */
export declare const STOPS: { id: number; n: number; c: [number, number] }[];

/** Walkways joining the platforms of one complex; `id` is the station id. */
export declare const LINKS: { id: number; c: [number, number][] }[];
