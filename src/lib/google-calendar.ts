// Google Calendar client for the Screening Room's two-way sync — thin REST over
// the Calendar API v3, no SDK. Single user, so unlike Strava (which rotates its
// refresh token every spend and keeps the pair in the DB) the credentials are
// static env values: a Google refresh token doesn't rotate, so there is nothing
// to write back.
//
// SETUP (once): create an OAuth 2.0 "Web application" client in a Google Cloud
// project with the Calendar API enabled, do the consent handshake for the
// `https://www.googleapis.com/auth/calendar` scope with `access_type=offline`,
// and put the four values in the environment:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN         — from the offline consent grant
//   GOOGLE_MOVIES_CALENDAR_ID    — the dedicated "Movies" calendar's id
//                                  (Calendar settings → Integrate calendar →
//                                  Calendar ID, e.g. "...@group.calendar.google.com")
//
// Everything is best-effortable by the caller: isConfigured() lets the queue
// still work as a plain local list when Calendar isn't set up.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

function env(name: string): string | undefined {
	const v = import.meta.env[name];
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Whether all four Calendar env values are present. When false the queue runs
 *  as a local-only list — nothing is pushed to or pulled from Google. */
export function isConfigured(): boolean {
	return Boolean(
		env('GOOGLE_CLIENT_ID') &&
			env('GOOGLE_CLIENT_SECRET') &&
			env('GOOGLE_REFRESH_TOKEN') &&
			env('GOOGLE_MOVIES_CALENDAR_ID'),
	);
}

function required(name: string): string {
	const v = env(name);
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

export function calendarId(): string {
	return required('GOOGLE_MOVIES_CALENDAR_ID');
}

// A short-lived access token, cached in module memory across calls within one
// server invocation. Refreshed a minute before it expires. ponytail: no lock —
// a single user's manual sync / add never overlaps enough to race the refresh.
let cached: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
	if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: required('GOOGLE_CLIENT_ID'),
			client_secret: required('GOOGLE_CLIENT_SECRET'),
			refresh_token: required('GOOGLE_REFRESH_TOKEN'),
			grant_type: 'refresh_token',
		}),
	});
	if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
	const t = (await res.json()) as { access_token: string; expires_in: number };
	cached = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
	return t.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	const token = await getAccessToken();
	const res = await fetch(`${API_BASE}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
	});
	return res;
}

/** One calendar event, as much of it as the sync reads. */
export interface CalEvent {
	id: string;
	summary: string;
	/** All-day events carry a `date` ("YYYY-MM-DD"); timed ones a `dateTime`. */
	start: { date?: string; dateTime?: string };
}

/**
 * Create a full-day event on `date` ("YYYY-MM-DD") titled `summary`. Google's
 * all-day `end.date` is exclusive, so it's the day after the start. Returns the
 * new event id.
 */
export async function createEvent(summary: string, date: string): Promise<string> {
	const res = await api(`/calendars/${encodeURIComponent(calendarId())}/events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			summary,
			start: { date },
			end: { date: addDay(date) },
		}),
	});
	if (!res.ok) throw new Error(`google create event ${res.status}: ${await res.text()}`);
	const ev = (await res.json()) as { id: string };
	return ev.id;
}

/** Delete an event by id. A 404/410 (already gone) is treated as success. */
export async function deleteEvent(eventId: string): Promise<void> {
	const res = await api(
		`/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
		{ method: 'DELETE' },
	);
	if (!res.ok && res.status !== 404 && res.status !== 410) {
		throw new Error(`google delete event ${res.status}: ${await res.text()}`);
	}
}

/**
 * Single (non-recurring, non-cancelled) events on the Movies calendar from
 * `timeMin` onward, oldest first. Pages through Google's `nextPageToken`. Used
 * by the inbound parse to pull AMC-style events into the queue.
 */
export async function listEvents(timeMin: string, timeMax?: string): Promise<CalEvent[]> {
	const out: CalEvent[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			singleEvents: 'true',
			orderBy: 'startTime',
			showDeleted: 'false',
			maxResults: '250',
			timeMin,
		});
		if (timeMax) params.set('timeMax', timeMax);
		if (pageToken) params.set('pageToken', pageToken);

		const res = await api(`/calendars/${encodeURIComponent(calendarId())}/events?${params}`);
		if (!res.ok) throw new Error(`google list events ${res.status}: ${await res.text()}`);
		const page = (await res.json()) as { items?: CalEvent[]; nextPageToken?: string };
		for (const ev of page.items ?? []) if (ev.summary) out.push(ev);
		pageToken = page.nextPageToken;
	} while (pageToken);
	return out;
}

/** The "YYYY-MM-DD" an event falls on — the all-day `date`, or the date part of
 *  a timed `dateTime`. Null when neither is present. */
export function eventDay(ev: CalEvent): string | null {
	if (ev.start.date) return ev.start.date;
	if (ev.start.dateTime && /^\d{4}-\d{2}-\d{2}/.test(ev.start.dateTime)) {
		return ev.start.dateTime.slice(0, 10);
	}
	return null;
}

/** The day after `date` ("YYYY-MM-DD"), for an all-day event's exclusive end. */
function addDay(date: string): string {
	const [y, m, d] = date.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + 1));
	const p = (n: number) => String(n).padStart(2, '0');
	return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
