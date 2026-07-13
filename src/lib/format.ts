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

/** Human label for a stored medium value (e.g. "plane" → "Airplane"). */
export function mediumLabel(medium: string | null | undefined): string | null {
	if (!medium) return null;
	const key = medium.trim().toLowerCase();
	if (!key) return null;
	return MEDIUM_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
