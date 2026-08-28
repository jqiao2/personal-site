// The public home feed and the RSS feed both want the same thing: the most
// recent things done across all four logs, as one reverse-chronological list,
// containing ONLY what a visitor is allowed to see. This is the single place
// that cross-section, visitor-safe read is assembled.
//
// The /month page builds the same four-track item list but for the owner, on a
// gated page, unredacted (it passes isOwner=true to the activity read and shows
// private books as blanked "A book" marks). A public feed cannot do either, so
// the rule here is stricter than /month's: drop, don't blank.
//   films   — the diary is already public.
//   books   — private books are dropped outright, not shown as "Private".
//   meals   — the restaurant diary has no private concept; all are public.
//   moves   — redactActivities strips private rows; we then keep only the ones
//             that came back published (private === false), minus any the owner
//             ticked out of the month review.

import type { JournalItem } from './journal-month';
import { filmItems, bookItems, mealItems, activityItems } from './journal-month';
import { listMonthWatches } from './films';
import { getReadingMonth } from './books-queries';
import { listMonthVisits } from './restaurants';
import { listActivitiesForMonth } from './activities';
import { listJournalMonths } from './journal-months';

/** One month's items across all four tracks, already reduced to what a visitor
 *  may see. */
async function monthItemsPublic(key: string): Promise<JournalItem[]> {
	const [watches, reading, visits, activities] = await Promise.all([
		listMonthWatches(key),
		getReadingMonth(key),
		listMonthVisits(key),
		// isOwner=false → redactActivities strips every private row to sport+date.
		listActivitiesForMonth(key, false),
	]);

	const publicBooks = reading.books.filter((b) => b.is_public);
	const publicIds = new Set(publicBooks.map((b) => b.id));

	return [
		...filmItems(watches),
		...bookItems(
			reading.days.filter((d) => publicIds.has(d.book_id)),
			publicBooks,
		),
		...mealItems(visits),
		// Only rows that redaction let through published, and not the ones held
		// back from the review. A redacted row has private === true, so this drops
		// it; a genuinely public row has private === false.
		...activityItems(activities.filter((a) => a.private === false && !a.hide_from_review)),
	];
}

/**
 * The most recent cross-section items, newest first, visitor-safe.
 *
 * Drawn from the two newest months that have anything in them rather than "this
 * calendar month", so the feed is never thin on the 1st. Two is enough: a month
 * of four logs is comfortably more than any home page shows, and the second is
 * only there to cover the turn of the month.
 */
export async function recentJournal(limit = 15): Promise<JournalItem[]> {
	const months = await listJournalMonths();
	const keys = months.slice(0, 2).map((m) => m.key);
	const perMonth = await Promise.all(keys.map(monthItemsPublic));
	return perMonth
		.flat()
		.sort(
			(a, b) =>
				b.day.localeCompare(a.day) ||
				a.track.localeCompare(b.track) ||
				a.key.localeCompare(b.key),
		)
		.slice(0, limit);
}

/** Singular track labels for a feed row's category tag. */
export const TRACK_TAG: Record<JournalItem['track'], string> = {
	film: 'Film',
	book: 'Book',
	meal: 'Meal',
	move: 'Activity',
};
