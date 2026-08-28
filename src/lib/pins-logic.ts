// The pure part of the pins feature: the cap rule and the visitor-visibility
// predicates. Kept free of any database import — like activity-privacy.ts —
// so scripts/pins.test.mjs can exercise it under plain node with no .env.
// pins.ts re-exports all of this, so the public contract still lives on pins.ts.

export type PinTrack = 'film' | 'book' | 'meal' | 'move';
export const MAX_PINS = 10;
export const PIN_TRACKS: readonly PinTrack[] = ['film', 'book', 'meal', 'move'];

/** Whether adding this pin is blocked by the cap: already at MAX and this pair
 *  is new. A re-pin of something already pinned is always allowed (a no-op). */
export function capCheck(existingCount: number, alreadyPinned: boolean): boolean {
	return existingCount >= MAX_PINS && !alreadyPinned;
}

/** A private book is dropped for a visitor — never blanked, never named. */
export function bookVisibleToVisitor(row: { is_public: boolean }): boolean {
	return row.is_public === true;
}

/** A private or held-back activity is dropped for a visitor. Same rule
 *  recent-journal.ts keeps: only an explicit `private === false` publishes. */
export function activityVisibleToVisitor(row: { private: boolean; hide_from_review: boolean }): boolean {
	return row.private === false && !row.hide_from_review;
}
