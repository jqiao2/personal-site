// Sort orders for one film list's page (/films/lists/[id]?sort=…).
//
// '' is the list's own order: hand-picked lists in the owner's dragged `position`
// order, smart lists in whatever order their saved query gives. The rest re-sort
// the already-loaded films; a list is at most 1000 films, so this stays in memory.

export type ListSort = '' | 'added' | 'title' | 'year' | 'rating';

export interface SortableFilm {
	title: string;
	release_year: number | null;
	rating?: number | null;
	added_at?: string;
}

/** The orders a list offers, with labels. Ratings are only loaded for smart lists; added dates only for hand-picked. */
export function listSorts(smart: boolean): { key: ListSort; label: string }[] {
	return [
		{ key: '', label: smart ? 'Default' : 'Custom' },
		...(smart ? [] : [{ key: 'added' as const, label: 'Recently added' }]),
		{ key: 'title', label: 'Title' },
		{ key: 'year', label: 'Release year' },
		...(smart ? [{ key: 'rating' as const, label: 'Rating' }] : []),
	];
}

/** A `?sort=` value narrowed to one the list offers, else the list's own order. */
export function parseListSort(raw: string | null, smart: boolean): ListSort {
	return listSorts(smart).find((s) => s.key === raw)?.key ?? '';
}

/** Highest first, missing values last. */
const desc = (a: number | null | undefined, b: number | null | undefined) => (b ?? -Infinity) - (a ?? -Infinity);

/** A sorted copy; ties keep the list's own order (Array#sort is stable). */
export function sortListFilms<T extends SortableFilm>(films: T[], sort: ListSort): T[] {
	const out = [...films];

	if (sort === 'title') out.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));

	if (sort === 'year') out.sort((a, b) => desc(a.release_year, b.release_year));

	if (sort === 'rating') out.sort((a, b) => desc(a.rating, b.rating));

	if (sort === 'added') out.sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''));

	return out;
}
