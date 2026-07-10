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
