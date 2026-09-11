// The privacy rule for the activity log, in one file with no database import —
// which is the point twice over: it is the single place the rule is written, and
// it can be exercised by a plain `node` test (scripts/privacy.test.mjs) instead
// of only in a browser against a live table.
//
// Two functions, because there are two ways a private activity leaks:
//   redactActivities — the row itself, handed to a template or an API client.
//   visitorQuery     — the QUESTION, which leaks the row's numbers even when
//                      the row never leaves the server. See its comment.
import type { ActivityListRow } from './activities';
import type { ActivityFilterQuery } from './activity-params';

// ---------------------------------------------------------------------------
// Redaction — the one gate every visitor-reachable read passes through.
// ---------------------------------------------------------------------------

/**
 * Strip private activities down to what a visitor is allowed to see: which
 * sport it was and which day. No title, no distance, no time of day, no route,
 * no gear, no place.
 *
 * WHY HERE AND NOT IN THE TEMPLATES. There are three renderers for an activity
 * card — the .astro component, the hand-built DOM nodes /activities/all pages
 * in with, and the JSON /api/activities/list hands out — and a rule enforced in
 * three places is a rule that will be enforced in two of them by next year. A
 * row that leaves this module already redacted cannot be leaked by a template
 * that forgets, or by a new endpoint that never knew.
 *
 * FAIL CLOSED, TWICE. `isOwner` defaults to false at every call site below, so
 * a caller that forgets to pass it gets the safe answer rather than the useful
 * one; and only an explicit `private === false` counts as published, so a
 * database that predates migration 0043 (no column, value `undefined`) redacts
 * everything rather than nothing.
 */
export function redactActivities<T extends ActivityListRow>(rows: T[], isOwner: boolean): T[] {
	if (isOwner) return rows;
	return rows.map((row) => (row.private === false ? row : redactOne(row)));
}

/** Build the visitor's row by nulling every field the row has and then putting
 * back the few that are public — rather than listing the ~50 to remove, which
 * is a list that goes stale the first time a column is added to the view. */
function redactOne<T extends ActivityListRow>(row: T): T {
	const blanked = Object.fromEntries(Object.keys(row).map((k) => [k, null]));
	return {
		...blanked,
		id: row.id,
		sport: row.sport,
		local_date: row.local_date,
		// Required by the type and read by callers that expect a number; zero is
		// the only value here that isn't a fact about the activity.
		elapsed_seconds: 0,
		title: '',
		has_streams: false,
		private: true,
		redacted: true,
	} as unknown as T;
}

/**
 * A visitor's version of a query: only the questions a redacted card could
 * already answer.
 *
 * Redacting the rows is not on its own enough, because a filter is a question
 * the database answers about rows the reader can't see. `?distmin=100000`
 * returns the icons of every activity over 100 km; move the bound and the
 * private distance is readable to any precision you like, one request at a
 * time. The same trick reads elevation, duration, exertion, gear and start
 * place, and a stat *sort* leaks the ordering even with no filter set at all.
 *
 * So a visitor's query keeps sport, date range and paging — the two facts a
 * redacted card shows anyway — and is forced back to date order. Everything
 * else is dropped server-side, where a hand-typed URL can't reach around it.
 */
export function visitorQuery(query: ActivityFilterQuery): ActivityFilterQuery {
	return {
		sports: query.sports,
		dateFrom: query.dateFrom,
		dateTo: query.dateTo,
		sort: 'date',
		sortDir: query.sortDir,
	};
}

// ---------------------------------------------------------------------------
// The default on import — migration 0061's backfill, as a function.
// ---------------------------------------------------------------------------

/** Mon–Fri 09:00–17:00 local. Anything overlapping it stays private. */
const WORK_DAYS = [1, 2, 3, 4, 5];
const WORK_START_H = 9;
const WORK_END_H = 17;
/** An activity long enough to swallow a whole work window without either end
 *  landing in one (Mon 17:00 → Tue 09:00) stays private rather than being
 *  reasoned about. */
const TOO_LONG_S = 16 * 3600;

/**
 * What `private` an imported activity gets: public unless it happened during
 * work hours. This is migration 0061's backfill rule applied going forward, so
 * a sync doesn't re-hide everything the backfill published.
 *
 * Overlap, not start time: a ride that starts at 08:30 and ends at 10:15 was a
 * ride during work hours. Only the two endpoints are tested — same as the SQL.
 *
 * Local time, because a run at 06:00 in Tokyo is not a run at 21:00 UTC. An
 * unknown offset, like an unknown anything here, stays private.
 *
 * Holidays and vacation days are not modelled; flip those by hand on the site.
 */
export function defaultPrivate(
	startedAt: string,
	utcOffsetMinutes: number | null | undefined,
	elapsedSeconds: number,
): boolean {
	const start = Date.parse(startedAt);
	if (!Number.isFinite(start) || utcOffsetMinutes === null || utcOffsetMinutes === undefined) return true;
	if (!(elapsedSeconds < TOO_LONG_S)) return true;

	const localStart = start + utcOffsetMinutes * 60_000;
	return [localStart, localStart + elapsedSeconds * 1000].some(inWorkHours);
}

function inWorkHours(ms: number): boolean {
	const t = new Date(ms);
	const hour = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600;
	return WORK_DAYS.includes(t.getUTCDay()) && hour >= WORK_START_H && hour < WORK_END_H;
}
