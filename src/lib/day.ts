// Where "today" comes from. A calendar day is not an instant, and
// `new Date().toISOString().slice(0, 10)` answers the question for UTC — which on
// a server in UTC (Vercel) rolls over at 8pm Eastern, so the composer would open
// on tomorrow's date all evening.
//
// Two answers, for two kinds of caller:
//
//   localDay() — the day it is where the USER is, read off the browser's own
//                clock. The default for anything the user is filling in, and the
//                only honest answer to "what did I watch today". Browser only:
//                on the server the runtime's zone is UTC, i.e. nobody's.
//   siteDay()  — the day in SITE_TZ, for server code that must name a day with no
//                browser to ask. Still a guess, but the owner's own zone rather
//                than UTC.
//
// Days are always "YYYY-MM-DD", the shape the SQL side and the date inputs use.

/** The zone the site's days are measured in when there's no client to ask. */
export const SITE_TZ = 'America/New_York';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The calendar day of `when` in the runtime's own timezone — in the browser, the
 * user's. Call this from client code; server-side it would just mean UTC.
 */
export function localDay(when: Date = new Date()): string {
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

// en-CA formats as YYYY-MM-DD, which is the shape the SQL side already uses.
const siteDayFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: SITE_TZ,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/** The calendar day an instant falls on in SITE_TZ, e.g. a `last_read_at`. */
export function siteDay(when: string | Date = new Date()): string {
	return siteDayFormat.format(typeof when === 'string' ? new Date(when) : when);
}

/** The current calendar year in SITE_TZ — not UTC's, which turns over early. */
export function siteYear(when: Date = new Date()): number {
	return Number(siteDay(when).slice(0, 4));
}
