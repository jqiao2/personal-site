// Format a "YYYY-MM-DD" watched date for display, parsing as a local date so it
// doesn't shift a day across timezones (as `new Date('2026-07-10')` would).
export function formatWatchedDate(date: string | null): string | null {
	if (!date) return null;
	const [y, m, d] = date.split('-').map(Number);
	if (!y || !m || !d) return date;
	return new Date(y, m - 1, d).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

/** First line of a review, trimmed to a single feed row (≤150 chars, ellipsised).
 *  Shared by the film and restaurant feeds. */
export function excerpt(text: string | null): string | null {
	if (!text) return null;
	const line = text.replace(/\s+/g, ' ').trim();
	if (!line) return null;
	return line.length > 150 ? `${line.slice(0, 149).trimEnd()}…` : line;
}

// Known viewing mediums → display label. Free-text mediums (the composer's
// "Other…") fall through to a capitalized version of whatever was stored.
const MEDIUM_LABELS: Record<string, string> = {
	theater: 'Theater',
	tv: 'TV',
	computer: 'Computer',
	plane: 'Airplane',
	tablet: 'iPad',
	ipad: 'iPad',
};

/**
 * Half-star rating as text, e.g. 3.5 → "★★★½" and 0.5 → "½". Null for anything
 * unrated, so callers pick their own wording for the absence.
 */
export function starText(rating: number | null | undefined): string | null {
	if (!rating) return null;
	return '★'.repeat(Math.floor(rating)) + (rating % 1 >= 0.5 ? '½' : '');
}

/** Human label for a stored medium value (e.g. "plane" → "Airplane"). */
export function mediumLabel(medium: string | null | undefined): string | null {
	if (!medium) return null;
	const key = medium.trim().toLowerCase();
	if (!key) return null;
	return MEDIUM_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** YTS search URL for a film, e.g. "bridge of spies 2015" → …/browse-movies/bridge%20of%20spies%202015/all/all/0/latest/0/all
 *
 * `year` should be the film's premiere year (its earliest release anywhere), which
 * is how YTS files films — not the US-opening year the site displays. See the
 * download link in /films/movie/[tmdbId]. */
export function ytsUrl(title: string, year: number | null): string {
	const query = year ? `${title} ${year}` : title;
	return `https://yts.gg/browse-movies/${encodeURIComponent(query.toLowerCase())}/all/all/0/latest/0/all`;
}
