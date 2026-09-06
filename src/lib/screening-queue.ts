// Service layer for the Screening Room — the dated "queued" watchlist. Sits
// between the API routes and Supabase + Google Calendar, so the endpoints stay
// thin. Two data sources meet here:
//
//   1. Manual adds from the site — pick a film + a date; we mirror it to the
//      Movies calendar as a full-day event.
//   2. The Movies calendar itself — AMC-app events like "The Uprising at AMC
//      34th Street 14" are parsed back into the queue (and onto the watchlist).
//
// The two stay in step through `screening_queue.google_event_id`: an event we
// created is already in the table under its id, so the inbound parse skips it.
import { supabaseAdmin, supabasePublic } from './supabase';
import { ensureMovieCached } from './films';
import { searchMovies } from './tmdb';
import { siteDay } from './day';
import * as gcal from './google-calendar';

/** A queued film as the calendar and preview render it. */
export interface QueueEntry {
	tmdb_id: number;
	title: string;
	release_year: number | null;
	poster_path: string | null;
	scheduled_date: string; // "YYYY-MM-DD"
	venue: string | null;
	source: 'manual' | 'calendar';
}

type QueueRow = {
	scheduled_date: string;
	venue: string | null;
	source: 'manual' | 'calendar';
	movies: {
		tmdb_id: number;
		title: string;
		release_year: number | null;
		poster_path: string | null;
	};
};

const SELECT = 'scheduled_date, venue, source, movies(tmdb_id, title, release_year, poster_path)';

function toEntry(r: QueueRow): QueueEntry {
	return {
		tmdb_id: r.movies.tmdb_id,
		title: r.movies.title,
		release_year: r.movies.release_year,
		poster_path: r.movies.poster_path,
		scheduled_date: r.scheduled_date,
		venue: r.venue,
		source: r.source,
	};
}

/** The whole queue, earliest scheduled first — powers the calendar page. */
export async function listQueue(): Promise<QueueEntry[]> {
	const { data, error } = await supabasePublic
		.from('screening_queue')
		.select(SELECT)
		.order('scheduled_date', { ascending: true });
	if (error) throw new Error(`listQueue failed: ${error.message}`);
	return ((data ?? []) as unknown as QueueRow[]).map(toEntry);
}

/** Queued films from today onward, earliest first — powers the watchlist
 *  preview row (most-imminent → furthest out). */
export async function listUpcomingQueue(limit = 5): Promise<QueueEntry[]> {
	const { data, error } = await supabasePublic
		.from('screening_queue')
		.select(SELECT)
		.gte('scheduled_date', siteDay())
		.order('scheduled_date', { ascending: true })
		.limit(limit);
	if (error) throw new Error(`listUpcomingQueue failed: ${error.message}`);
	return ((data ?? []) as unknown as QueueRow[]).map(toEntry);
}

/** The calendar event title for a queued film. Kept in the AMC "{title} at
 *  {venue}" shape when there's a venue, so a round-trip parses cleanly. */
export function eventSummary(title: string, venue: string | null): string {
	return venue ? `${title} at ${venue}` : title;
}

/** Ensure a movie is on the plain watchlist too (idempotent) — queueing a film
 *  is a stronger statement of "to watch", and a calendar-sourced film must land
 *  on the watchlist first. */
async function ensureOnWatchlist(movieId: number): Promise<void> {
	const { error } = await supabaseAdmin
		.from('watchlist')
		.upsert({ movie_id: movieId }, { onConflict: 'movie_id' });
	if (error) throw new Error(`ensureOnWatchlist failed: ${error.message}`);
}

/**
 * Schedule a film. Caches the movie, puts it on the watchlist, and (when
 * Calendar is configured) creates the full-day event, storing its id. Re-adding
 * a film already queued moves its date/venue and replaces its calendar event.
 */
export async function addToQueue(input: {
	tmdbId: number;
	scheduledDate: string;
	venue?: string | null;
	source?: 'manual' | 'calendar';
	/** A pre-existing calendar event to mirror (inbound parse) rather than create. */
	googleEventId?: string | null;
}): Promise<void> {
	const movie = await ensureMovieCached(input.tmdbId);
	await ensureOnWatchlist(movie.id);

	const venue = input.venue?.trim() || null;
	const source = input.source ?? 'manual';

	// The row that may already exist for this movie — its event has to be cleaned
	// up if we're about to create a replacement.
	const { data: existing } = await supabaseAdmin
		.from('screening_queue')
		.select('google_event_id')
		.eq('movie_id', movie.id)
		.maybeSingle();

	let eventId = input.googleEventId ?? null;
	// A manual add (no event handed in) mirrors to Google when configured.
	if (!eventId && source === 'manual' && gcal.isConfigured()) {
		if (existing?.google_event_id) await safeDeleteEvent(existing.google_event_id);
		eventId = await gcal.createEvent(eventSummary(movie.title, venue), input.scheduledDate);
	}

	const { error } = await supabaseAdmin.from('screening_queue').upsert(
		{
			movie_id: movie.id,
			scheduled_date: input.scheduledDate,
			venue,
			source,
			google_event_id: eventId,
		},
		{ onConflict: 'movie_id' },
	);
	if (error) throw new Error(`addToQueue failed: ${error.message}`);
}

/** Remove a film from the queue by TMDB id, deleting its calendar event too.
 *  Returns false when it wasn't queued. Leaves the watchlist alone. */
export async function removeFromQueue(tmdbId: number): Promise<boolean> {
	const { data: movie, error: mErr } = await supabaseAdmin
		.from('movies')
		.select('id')
		.eq('tmdb_id', tmdbId)
		.maybeSingle();
	if (mErr) throw new Error(`removeFromQueue lookup failed: ${mErr.message}`);
	if (!movie) return false;

	const { data: row, error } = await supabaseAdmin
		.from('screening_queue')
		.delete()
		.eq('movie_id', movie.id)
		.select('google_event_id')
		.maybeSingle();
	if (error) throw new Error(`removeFromQueue failed: ${error.message}`);
	if (!row) return false;
	if (row.google_event_id) await safeDeleteEvent(row.google_event_id);
	return true;
}

/** Delete a calendar event without letting a Google hiccup fail the DB write
 *  that's the source of truth. */
async function safeDeleteEvent(eventId: string): Promise<void> {
	if (!gcal.isConfigured()) return;
	try {
		await gcal.deleteEvent(eventId);
	} catch (err) {
		console.error('screening-queue: could not delete calendar event —', err);
	}
}

/**
 * Split a calendar event title into a film title and (AMC) venue.
 * "The Uprising at AMC 34th Street 14" → { title: "The Uprising", venue: "AMC 34th Street 14" }.
 * A title with no " at AMC …" suffix is taken whole, with no venue.
 */
export function parseEventSummary(summary: string): { title: string; venue: string | null } {
	const m = /^(.+?)\s+at\s+(AMC\b.+)$/i.exec(summary.trim());
	if (m) return { title: m[1].trim(), venue: m[2].trim() };
	return { title: summary.trim(), venue: null };
}

export interface SyncResult {
	added: number;
	skipped: number;
	/** Titles the TMDB search couldn't resolve — reported so they can be fixed by hand. */
	unresolved: string[];
}

/**
 * Pull the Movies calendar into the queue: parse each event from the start of
 * the current month onward, resolve its title to a TMDB film, and schedule it.
 * Events we created (already stored under their id) are skipped. Films not yet
 * on the watchlist are added there by addToQueue.
 */
export async function syncFromCalendar(): Promise<SyncResult> {
	if (!gcal.isConfigured()) throw new Error('Google Calendar is not configured');

	// From the first of the current month — far enough back to catch things
	// scheduled earlier this month, not so far it re-imports old history.
	const timeMin = `${siteDay().slice(0, 7)}-01T00:00:00Z`;
	const events = await gcal.listEvents(timeMin);

	// Event ids we've already mirrored — dedupes our own creations and prior syncs.
	const { data: known, error } = await supabaseAdmin
		.from('screening_queue')
		.select('google_event_id')
		.not('google_event_id', 'is', null);
	if (error) throw new Error(`syncFromCalendar read failed: ${error.message}`);
	const seen = new Set((known ?? []).map((r) => r.google_event_id as string));

	const result: SyncResult = { added: 0, skipped: 0, unresolved: [] };
	for (const ev of events) {
		if (seen.has(ev.id)) {
			result.skipped++;
			continue;
		}
		const day = gcal.eventDay(ev);
		if (!day) {
			result.skipped++;
			continue;
		}
		const { title, venue } = parseEventSummary(ev.summary);
		const tmdbId = await resolveTitle(title);
		if (!tmdbId) {
			result.unresolved.push(title);
			continue;
		}
		await addToQueue({
			tmdbId,
			scheduledDate: day,
			venue,
			source: 'calendar',
			googleEventId: ev.id,
		});
		result.added++;
	}
	return result;
}

/** First TMDB search hit for a title, or null. */
async function resolveTitle(title: string): Promise<number | null> {
	try {
		const res = await searchMovies(title);
		return res.results[0]?.id ?? null;
	} catch (err) {
		console.error(`screening-queue: TMDB search failed for "${title}" —`, err);
		return null;
	}
}
