// Which months the combined card has anything to draw — the union of the four
// sections' own month indexes.
//
// A union, not an intersection: a month with only meals in it is still a month
// I lived, and the card draws it fine. The only months left out are the ones
// where all four are empty, which would render as a blank grid.
//
// Each section already knows its own months, so this asks each of them rather
// than running a fifth query over four tables. The activities view is read
// inline because that track deliberately exports no listing function
// (ACTIVITIES.md §9) — the same inline select its own month index uses.

import { TRACKS, type Track } from './journal-month';
import { countWatchesByMonth } from './films';
import { countReadingByMonth } from './books-queries';
import { listMonthKeys } from './restaurants';
import { supabasePublic } from './supabase';

async function activityMonths(): Promise<string[]> {
	const { data, error } = await supabasePublic
		.from('activity_months')
		.select('month_key, activity_count');
	if (error) return [];
	return (data ?? [])
		.filter((row) => (row.activity_count as number) > 0)
		.map((row) => row.month_key as string);
}

export interface JournalMonth {
	key: string;
	/** Which of the four tracks that month has anything in, in TRACKS order. */
	tracks: Track[];
}

/** Every month with something in it, newest first, and which tracks it holds. */
export async function listJournalMonths(): Promise<JournalMonth[]> {
	const [films, books, meals, moves] = await Promise.all([
		countWatchesByMonth(),
		countReadingByMonth(),
		listMonthKeys(),
		activityMonths(),
	]);
	const mealSet = new Set(meals);
	const moveSet = new Set(moves);
	const has: Record<Track, (key: string) => boolean> = {
		film: (key) => (films[key] ?? 0) > 0,
		book: (key) => (books[key] ?? 0) > 0,
		meal: (key) => mealSet.has(key),
		move: (key) => moveSet.has(key),
	};
	const keys = new Set<string>([
		...Object.keys(films).filter(has.film),
		...Object.keys(books).filter(has.book),
		...meals,
		...moves,
	]);
	return [...keys]
		.sort()
		.reverse()
		.map((key) => ({ key, tracks: TRACKS.map((t) => t.id).filter((id) => has[id](key)) }));
}
