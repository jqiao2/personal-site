// Pull new rides from Strava — ACTIVITIES.md §4 step 3's engine.
//
// The archive importer carries the whole back-catalogue once; this keeps it
// current. It polls `/athlete/activities` for anything started after the
// stored watermark, and for each new one it runs the SAME canonical pipeline
// every other provider does: parse (providers/strava.ts) → dedupe → exertion +
// route (toRows) → store. Nothing about a synced ride is stored differently
// from an imported one except its `activity_sources.provider` ('strava_api',
// which the API Agreement's attribution rule keys off — see ACTIVITIES.md §4).
//
// Triggered two ways, both in src/pages/api/activities/strava/sync.ts: the
// owner's "Sync now" button, and a daily Vercel cron.
import { supabaseAdmin } from './supabase';
import { getAccessToken, stravaGet } from './strava';
import { toRows, localDate, UnknownSportError, virtualizeGpslessRide } from './ingest/canonical';
import { activityToCanonical, type StravaActivity, type StravaStreams } from './ingest/providers/strava';
import { FIVE_MINUTES, thresholdsFrom, insertActivity, bumpGearDistance } from './activity-ingest';
import type { AthleteThresholds } from './activities';

// A synced ride is Strava's copy, not the device's — same rung as the archive
// (strava_archive = 80). A device FIT dropped later (fidelity 90) still wins.
const STRAVA_API_FIDELITY = 80;

// The streams worth fetching: everything toRows/exertion can use.
const STREAM_KEYS = 'time,latlng,altitude,distance,heartrate,cadence,watts,velocity_smooth,temp,grade_smooth,moving';

export interface SyncResult {
	fetched: number;
	added: number;
	duplicate: number;
	failed: number;
	unknownSports: string[];
}

/** Why this Strava activity is already stored, or null. Same two rules as the
 *  file drop (add-activities.mjs): the exact external id, then same sport
 *  starting within five minutes (catches the archive/FIT copy of one ride). */
async function alreadyStored(a: StravaActivity, canonicalSport: string): Promise<string | null> {
	const { data: byId } = await supabaseAdmin
		.from('activity_sources')
		.select('activity_id')
		.eq('external_id', String(a.id))
		.limit(1)
		.maybeSingle();
	if (byId) return `external id ${a.id} is activity ${byId.activity_id}`;

	const t = Date.parse(a.start_date);
	const { data: near } = await supabaseAdmin
		.from('activities')
		.select('id, sport')
		.gte('started_at', new Date(t - FIVE_MINUTES).toISOString())
		.lte('started_at', new Date(t + FIVE_MINUTES).toISOString())
		.is('deleted_at', null);
	const match = (near ?? []).find((r) => r.sport === canonicalSport);
	return match ? `activity ${match.id} starts within 5 min` : null;
}

/** Strava gear id → our activity_gear id, by matching the Strava gear name to a
 *  gear name or nickname. Built once per run, and only if a ride carries gear.
 *
 *  ponytail: name match, not a stored id map. The archive never recorded
 *  Strava's gear ids, so name is what there is to match on; a rename on either
 *  side drops the tag (the ride lands untagged and stays editable). Good enough
 *  for a trickle of live rides; wire real ids in if it ever misses often. */
async function buildGearResolver(): Promise<(gearId: string | null | undefined) => number | null> {
	const athlete = (await stravaGet('/athlete')) as { bikes?: Gear[]; shoes?: Gear[] };
	const stravaGear = [...(athlete.bikes ?? []), ...(athlete.shoes ?? [])];
	if (!stravaGear.length) return () => null;

	const { data } = await supabaseAdmin.from('activity_gear').select('id, name, nickname').is('retired_at', null);
	const byName = new Map<string, number>();
	for (const g of (data ?? []) as { id: number; name: string; nickname: string | null }[]) {
		byName.set(g.name.toLowerCase(), g.id);
		if (g.nickname) byName.set(g.nickname.toLowerCase(), g.id);
	}

	const stravaName = new Map<string, string>();
	for (const g of stravaGear) if (g.id && g.name) stravaName.set(g.id, g.name);

	return (gearId) => {
		if (!gearId) return null;
		const name = stravaName.get(gearId);
		return name ? byName.get(name.toLowerCase()) ?? null : null;
	};
}
interface Gear {
	id?: string;
	name?: string;
}

/**
 * Poll Strava and store anything new. `max` caps how many activities one run
 * will pull (a page is 100), so the daily cron can't accidentally chew through
 * a rate limit if the watermark is far back.
 */
export async function syncStrava({ max = 100 }: { max?: number } = {}): Promise<SyncResult> {
	await getAccessToken(); // fail fast (and clearly) if not connected

	const { data: authRow } = await supabaseAdmin.from('strava_auth').select('last_sync_at').eq('id', 1).maybeSingle();
	const after = authRow?.last_sync_at ? Math.floor(Date.parse(authRow.last_sync_at) / 1000) : undefined;

	const { data: thresholdRows } = await supabaseAdmin
		.from('athlete_thresholds')
		.select('*')
		.order('effective_from', { ascending: true });
	const thresholds = (thresholdRows ?? []) as AthleteThresholds[];

	const result: SyncResult = { fetched: 0, added: 0, duplicate: 0, failed: 0, unknownSports: [] };
	let gearFor: ((id: string | null | undefined) => number | null) | null = null;
	let newestStart = after ? after * 1000 : 0;
	let reachedMax = false;

	for (let page = 1; ; page++) {
		const params: Record<string, string | number> = { per_page: 100, page };
		if (after) params.after = after;
		const list = (await stravaGet('/athlete/activities', params)) as StravaActivity[];
		if (!Array.isArray(list) || !list.length) break;
		result.fetched += list.length;

		for (const summary of list) {
			if (result.added >= max) {
				reachedMax = true;
				break;
			}
			try {
				// The summary already carries sport_type; dedupe before spending two
				// GETs on a ride we already have.
				const sport = activityToCanonical(summary).sport;
				const dup = await alreadyStored(summary, sport);
				if (dup) {
					result.duplicate++;
					continue;
				}

				const detail = (await stravaGet(`/activities/${summary.id}`)) as StravaActivity;
				let streams: StravaStreams | null = null;
				try {
					streams = (await stravaGet(`/activities/${summary.id}/streams`, {
						keys: STREAM_KEYS,
						key_by_type: 'true',
					})) as StravaStreams;
				} catch {
					// No streams (manual entry, or Strava has none) — a normal reading.
					streams = null;
				}

				const canonical = virtualizeGpslessRide(activityToCanonical(detail, streams));
				const date = localDate(canonical.started_at, canonical.utc_offset_minutes ?? 0);
				const { activity, streams: streamRow, laps } = toRows(canonical, thresholdsFrom(thresholds, date));

				if (detail.gear_id) {
					if (!gearFor) gearFor = await buildGearResolver();
					const gearId = gearFor(detail.gear_id);
					if (gearId) activity.gear_id = gearId;
				}

				await insertActivity(activity, streamRow, laps, {
					provider: 'strava_api',
					external_id: String(summary.id),
					external_url: `https://www.strava.com/activities/${summary.id}`,
					fidelity: STRAVA_API_FIDELITY,
					raw: { gear_id: detail.gear_id ?? null, sport_type: detail.sport_type ?? detail.type ?? null },
				});
				if (activity.gear_id) await bumpGearDistance(activity.gear_id as number, activity.distance_m as number);

				result.added++;
				newestStart = Math.max(newestStart, Date.parse(canonical.started_at));
			} catch (err) {
				if (err instanceof UnknownSportError) {
					result.failed++;
					if (!result.unknownSports.includes(err.providerType)) result.unknownSports.push(err.providerType);
				} else {
					result.failed++;
					console.error(`strava sync: activity ${summary.id} failed —`, err);
				}
			}
		}

		if (result.added >= max || list.length < 100) break;
	}

	// Advance the watermark to the newest ride we actually stored, so a failed
	// activity is retried next run rather than skipped. Only move it forward —
	// and NOT when the max cap cut the run short, or older un-pulled rides
	// (before the newest stored one) would be excluded by the `after` filter
	// forever. Leaving it put re-lists them next run; dedupe makes that cheap.
	if (result.added > 0 && newestStart > 0 && !reachedMax) {
		await supabaseAdmin
			.from('strava_auth')
			.update({ last_sync_at: new Date(newestStart).toISOString(), updated_at: new Date().toISOString() })
			.eq('id', 1);
	}

	return result;
}
