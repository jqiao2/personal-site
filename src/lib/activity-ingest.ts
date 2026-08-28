// The server side of ACTIVITIES.md §4, steps 2 and 3, shared.
//
// Two write paths run the same canonical pipeline (parse → dedupe → toRows →
// store): the Strava OAuth sync (strava-sync.ts) and the file uploader
// (/api/activities/upload). The generic pieces of that pipeline live here so
// there is one insert, one threshold lookup and one gear-distance bump, not a
// copy per caller.
//
// The file path itself — parse a .fit/.gpx/.tcx buffer, checksum-dedupe it,
// default its gear and store it — is `ingestFiles` below. It is the drop
// folder (scripts/add-activities.mjs) as an endpoint: same rules, same
// fidelity (90, above Strava's mirror), except the file arrives over HTTP
// instead of off the desktop, so nothing has to leave the machine to run it.
import { supabaseAdmin } from './supabase';
import { toRows, localDate, UnknownSportError, virtualizeGpslessRide } from './ingest/canonical';
import type { CanonicalActivity } from './ingest/canonical';
import { parseFitSessions } from './ingest/fit';
import { parseGpx, parseTcx } from './ingest/gpx';
import { SPORTS, type Sport } from './sports';
import type { AthleteThresholds } from './activities';
import type { Thresholds } from './exertion';

export const FIVE_MINUTES = 5 * 60 * 1000;
// A device file (Garmin/Wahoo FIT, or a per-activity GPX export) is what the
// device recorded — above strava_archive's 80 and strava_api's 80, so a FIT
// dropped later still wins a dedupe against the same ride pulled from Strava.
const FILE_FIDELITY = 90;

// ---------------------------------------------------------------------------
// Shared write helpers (also used by strava-sync.ts)
// ---------------------------------------------------------------------------

/** The threshold row in force on a date, as `computeExertion` wants it — §5's
 *  "last row whose effective_from is on or before the day" rule. */
export function thresholdsFrom(rows: AthleteThresholds[], date: string): Thresholds {
	let inForce: AthleteThresholds | null = null;
	for (const r of rows) {
		if (r.effective_from <= date) inForce = r;
		else break;
	}
	return {
		ftp_w: inForce?.ftp_w ?? null,
		lthr_bpm: inForce?.lthr_bpm ?? null,
		max_hr: inForce?.max_hr ?? null,
		rest_hr: inForce?.rest_hr ?? null,
		threshold_pace_s_per_km: inForce?.threshold_pace_s_per_km ?? null,
		css_pace_s_per_100m: inForce?.css_pace_s_per_100m ?? null,
		weight_kg: inForce?.weight_kg ?? null,
	};
}

/** Insert one activity with its provenance, streams and laps — rolled back
 *  whole if any child insert fails, so a half-written activity never survives
 *  to be picked up as a dedupe match. */
export async function insertActivity(
	activity: Record<string, unknown>,
	streams: Record<string, unknown> | null,
	laps: Record<string, unknown>[],
	source: Record<string, unknown>,
): Promise<number> {
	const { data, error } = await supabaseAdmin.from('activities').insert(activity).select('id').single();
	if (error) throw new Error(`insert activities: ${error.message}`);
	const id = data.id as number;
	try {
		const { error: es } = await supabaseAdmin.from('activity_sources').insert({ ...source, activity_id: id });
		if (es) throw new Error(`insert activity_sources: ${es.message}`);
		if (streams) {
			const { error: e2 } = await supabaseAdmin.from('activity_streams').insert({ activity_id: id, ...streams });
			if (e2) throw new Error(`insert activity_streams: ${e2.message}`);
		}
		if (laps.length) {
			const { error: e3 } = await supabaseAdmin.from('activity_laps').insert(laps.map((l) => ({ ...l, activity_id: id })));
			if (e3) throw new Error(`insert activity_laps: ${e3.message}`);
		}
	} catch (err) {
		await supabaseAdmin.from('activities').delete().eq('id', id);
		throw err;
	}
	return id;
}

export async function bumpGearDistance(gearId: number, distanceM: number | null | undefined): Promise<void> {
	if (!distanceM) return;
	const { data } = await supabaseAdmin.from('activity_gear').select('distance_m').eq('id', gearId).maybeSingle();
	if (!data) return;
	const next = Math.max(0, (data.distance_m ?? 0) + distanceM);
	await supabaseAdmin.from('activity_gear').update({ distance_m: next, updated_at: new Date().toISOString() }).eq('id', gearId);
}

// ---------------------------------------------------------------------------
// Default gear per sport — the drop folder's DEFAULT_GEAR, on the server.
// ---------------------------------------------------------------------------

/**
 * What each sport is done on, when the file names no gear. Gear is what turns a
 * ride into chain mileage, so a file with none would otherwise sit outside the
 * component-wear numbers until someone remembered to tag it. This is the
 * owner's own list, and every uploaded activity stays editable on the site, so
 * a default is a first guess on a record that can be corrected — not a fact.
 *
 * Only sports with an unambiguous answer are here. A mountain bike ride, a
 * swim, a ski day get nothing rather than something plausible. Names, not ids,
 * so the list is checkable by eye against /activities/gear.
 *
 * Kept in sync with scripts/add-activities.mjs by hand — two short lists that
 * rarely change beat a shared module the .mjs (plain node, no bundler) can't
 * import cleanly.
 */
const DEFAULT_GEAR: Partial<Record<Sport, string>> = {
	ride: 'Cervélo S3',
	virtual_ride: 'Cervélo S3',
	gravel_ride: 'Burple',
	run: 'Brooks Ghost Max 2',
	treadmill_run: 'Brooks Ghost Max 2',
	trail_run: 'Altra Lone Peak 9',
	hike: 'Altra Lone Peak 9',
};

interface GearRow {
	id: number;
	name: string;
	first_used_on: string | null;
	retired_at: string | null;
}

/** The gear a sport defaults to on a date, or a reason there is none. A default
 *  only applies while the gear was IN SERVICE on the day — a June hike uploaded
 *  after a July shoe change is not credited to the pair that replaced them. */
function defaultGearFor(sport: Sport, date: string, gear: GearRow[]): GearRow | { out: string } | null {
	const name = DEFAULT_GEAR[sport];
	if (!name) return null;
	const g = gear.find((r) => r.name.toLowerCase() === name.toLowerCase());
	if (!g) return { out: `no gear named ${name}` };
	if (g.first_used_on && date < g.first_used_on) return { out: `${g.name} was not in service on ${date}` };
	if (g.retired_at && date >= g.retired_at.slice(0, 10)) return { out: `${g.name} was retired by ${date}` };
	return g;
}

// ---------------------------------------------------------------------------
// Parse a buffer
// ---------------------------------------------------------------------------

const PARSEABLE = /\.(fit|gpx|tcx)(\.gz)?$/i;

export function isParseable(filename: string): boolean {
	return PARSEABLE.test(filename);
}

/** Web-API gunzip (node's zlib isn't in scope for src — see crypto.subtle in
 *  auth.ts for the same choice). Vercel's runtime has DecompressionStream. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
	return new Uint8Array(await stream.arrayBuffer());
}

/** sha256 as hex, via Web Crypto — the same digest the drop folder writes with
 *  node's createHash, so a file imported both ways dedupes on one checksum. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One canonical activity from a file's bytes, or a reason there isn't one.
 *  Mirrors scripts/add-activities.mjs' parseFile: gunzip if needed, dispatch on
 *  extension, refuse a multisport FIT (it needs the parent/leg structure the
 *  archive importer builds). Throws UnknownSportError when the file states no
 *  sport and none was forced — the caller turns that into "pick a sport". */
async function parseBuffer(
	bytes: Uint8Array,
	filename: string,
	forcedSport?: Sport,
): Promise<{ canonical: CanonicalActivity } | { skip: string }> {
	const lower = filename.toLowerCase();
	const buf = lower.endsWith('.gz') ? await gunzip(bytes) : bytes;
	const kind = lower.replace(/\.gz$/i, '').match(/\.(fit|gpx|tcx)$/)?.[1];
	const opts = forcedSport ? { sport: forcedSport } : {};

	if (kind === 'fit') {
		const sessions = parseFitSessions(buf, opts);
		if (!sessions.length) return { skip: 'not a FIT file, or no session in it' };
		// A multisport recording (a triathlon: swim/T1/bike/T2/run in one file)
		// needs §5's parent_id/leg structure that only the archive importer
		// builds. One uploaded triathlon is not worth a second copy of it.
		if (sessions.length > 1) return { skip: `${sessions.length} sessions (multisport) — use the archive importer` };
		return { canonical: sessions[0] };
	}

	const xml = new TextDecoder('utf-8').decode(buf);
	const canonical = kind === 'gpx' ? parseGpx(xml, opts) : parseTcx(xml, opts);
	if (!canonical) return { skip: 'no trackpoints with a clock' };
	return { canonical };
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/** Why this file is already stored, or null. §4's first two rules: the exact
 *  file (its sha256 against the unique activity_sources.file_checksum), then
 *  the same sport starting within five minutes (catches the same session
 *  arriving as both a Garmin FIT and a Strava GPX). */
async function alreadyStored(checksum: string, canonical: CanonicalActivity): Promise<string | null> {
	const { data: bySum } = await supabaseAdmin
		.from('activity_sources')
		.select('activity_id')
		.eq('file_checksum', checksum)
		.limit(1)
		.maybeSingle();
	if (bySum) return `this exact file is activity ${bySum.activity_id}`;

	const t = Date.parse(canonical.started_at);
	const { data: near } = await supabaseAdmin
		.from('activities')
		.select('id, sport, started_at')
		.gte('started_at', new Date(t - FIVE_MINUTES).toISOString())
		.lte('started_at', new Date(t + FIVE_MINUTES).toISOString())
		.is('deleted_at', null);
	const match = (near ?? []).find((a) => a.sport === canonical.sport);
	return match ? `activity ${match.id} starts within 5 min` : null;
}

// ---------------------------------------------------------------------------
// The uploader
// ---------------------------------------------------------------------------

export interface UploadFile {
	name: string;
	bytes: Uint8Array;
}

export interface FileResult {
	name: string;
	status: 'added' | 'duplicate' | 'skipped' | 'failed';
	detail: string;
	activityId?: number;
}

export interface UploadResult {
	results: FileResult[];
	added: number;
	duplicate: number;
	skipped: number;
	failed: number;
	/** Files that stated no sport and had none forced — the UI offers to retry
	 *  these once the owner picks a sport. */
	needSport: string[];
}

export interface UploadOptions {
	/** Force the sport for every file, for files that don't state one (a bare
	 *  GPS-track GPX). One of the SPORTS slugs. */
	sport?: Sport;
	/** Tag every file to this gear by name, overriding the per-sport default. */
	gearName?: string;
	/** Tag nothing, not even the per-sport default. */
	noGear?: boolean;
}

export function isSport(slug: string): slug is Sport {
	return (SPORTS as readonly string[]).includes(slug);
}

/**
 * Parse, dedupe, score and store a batch of uploaded files. Thresholds and gear
 * are read once for the whole batch, then each file runs the pipeline the drop
 * folder does. One bad file fails only itself; the rest of the batch continues.
 */
export async function ingestFiles(files: UploadFile[], opts: UploadOptions = {}): Promise<UploadResult> {
	const result: UploadResult = { results: [], added: 0, duplicate: 0, skipped: 0, failed: 0, needSport: [] };

	const { data: thresholdRows } = await supabaseAdmin
		.from('athlete_thresholds')
		.select('*')
		.order('effective_from', { ascending: true });
	const thresholds = (thresholdRows ?? []) as AthleteThresholds[];

	const { data: gearData } = opts.noGear
		? { data: [] }
		: await supabaseAdmin.from('activity_gear').select('id, name, first_used_on, retired_at');
	const gear = (gearData ?? []) as GearRow[];

	const forcedGear = opts.gearName
		? gear.find((g) => g.name.toLowerCase() === opts.gearName!.toLowerCase()) ?? null
		: null;
	if (opts.gearName && !forcedGear) {
		// A named gear that matches nothing is the owner's mistake, not a per-file
		// one — fail the whole batch loudly rather than silently tag nothing.
		throw new Error(`no gear named ${opts.gearName} — see /activities/gear for the names in use`);
	}

	for (const file of files) {
		const push = (status: FileResult['status'], detail: string, activityId?: number) => {
			result[status]++;
			result.results.push({ name: file.name, status, detail, activityId });
		};

		let parsed: { canonical: CanonicalActivity } | { skip: string };
		try {
			parsed = await parseBuffer(file.bytes, file.name, opts.sport);
		} catch (err) {
			if (err instanceof UnknownSportError) {
				result.needSport.push(file.name);
				push('failed', 'states no sport — pick one and re-upload');
			} else {
				push('failed', err instanceof Error ? err.message : String(err));
			}
			continue;
		}

		if ('skip' in parsed) {
			push('skipped', parsed.skip);
			continue;
		}

		const canonical = virtualizeGpslessRide(parsed.canonical);
		try {
			const checksum = await sha256Hex(file.bytes);
			const dup = await alreadyStored(checksum, canonical);
			if (dup) {
				push('duplicate', dup);
				continue;
			}

			const date = localDate(canonical.started_at, canonical.utc_offset_minutes ?? 0);
			const { activity, streams, laps } = toRows(canonical, thresholdsFrom(thresholds, date));

			let gearNote = '';
			if (!opts.noGear) {
				const g = forcedGear ?? defaultGearFor(canonical.sport, date, gear);
				if (g && 'id' in g) {
					activity.gear_id = g.id;
					gearNote = `, on ${g.name}`;
				} else if (g && 'out' in g) {
					gearNote = `, no gear: ${g.out}`;
				}
			}

			const id = await insertActivity(activity, streams, laps, {
				provider: 'file',
				file_name: file.name,
				file_checksum: checksum,
				fidelity: FILE_FIDELITY,
			});
			if (activity.gear_id) await bumpGearDistance(activity.gear_id as number, activity.distance_m as number);

			const km = ((canonical.distance_m ?? 0) / 1000).toFixed(1);
			push('added', `${canonical.sport} ${date} ${km}km, exertion ${activity.exertion ?? '-'} (${activity.exertion_method ?? 'none'})${gearNote}`, id);
		} catch (err) {
			push('failed', err instanceof Error ? err.message : String(err));
		}
	}

	return result;
}
