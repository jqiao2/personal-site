// Shapes for the shared diary Entry Editor modal, plus the mapping from a stored
// log to the values its form seeds from. The diary entry page opens the editor
// on an existing entry, so the mapping lives here rather than in the page.

/** The film an entry is about. Supplying one to the editor locks its picker. */
export interface EntryEditorFilm {
	tmdbId: number;
	title: string;
	year: number | null;
	poster: string | null;
}

/** The editor form's values, as the page hands them over. */
export interface EntryEditorInitial {
	date: string;
	rating: number | null;
	liked: boolean;
	rewatch: boolean;
	medium: string | null;
	otherMedium: string;
	venue: string;
	format: string;
	review: string;
	/** The owner's private note. '' when there is none — and '' is also what a
	 *  non-owner would get, because the page never loads the column for them. */
	privateNote: string;
	tags: string[];
	friends: string[];
}

/** The mediums the editor offers as buttons; anything else is a free-text "other". */
const CANONICAL_MEDIA = ['theater', 'tv', 'computer', 'plane'];

/** The parts of a stored log the editor seeds from. */
export interface StoredEntry {
	watched_date: string | null;
	rating: number | null;
	review_text: string | null;
	private_note: string | null;
	rewatched: boolean;
	liked: boolean;
	medium: string | null;
	theater: { name: string; city: string | null } | null;
	format: string | null;
	tags: string[];
	friends: string[];
}

/** A stored log → the editor form's initial values. */
export function toEditorInitial(entry: StoredEntry): EntryEditorInitial {
	const mediumKey = entry.medium
		? CANONICAL_MEDIA.includes(entry.medium)
			? entry.medium
			: 'other'
		: null;
	return {
		date: entry.watched_date ?? '',
		rating: entry.rating,
		liked: entry.liked,
		rewatch: entry.rewatched,
		medium: mediumKey,
		otherMedium: mediumKey === 'other' ? (entry.medium ?? '') : '',
		venue: entry.theater ? [entry.theater.name, entry.theater.city].filter(Boolean).join(', ') : '',
		format: entry.format ?? '',
		review: entry.review_text ?? '',
		privateNote: entry.private_note ?? '',
		tags: entry.tags,
		friends: entry.friends,
	};
}
