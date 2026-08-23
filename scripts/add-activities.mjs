// Add activities from a folder of files — ACTIVITIES.md §4, step 2.
//
// Drop a .fit/.gpx/.tcx in a folder (whatever Garmin, Wahoo, TrainerRoad or
// Strava's per-activity export hands you), run this, and the same pipeline the
// archive importer uses parses it, scores it (§3), draws its route (§7) and
// writes it. Files that land are moved into `imported/`, so the folder stays a
// to-do list rather than a growing pile.
//
// Usage:
//   npm run activities:add                    # the default drop folder
//   npm run activities:add -- <dir-or-file> [options]
//
//   --sport SLUG   force the sport, for a file that doesn't state one
//   --dry          parse and report, write nothing, move nothing
//   --keep         write, but leave the files where they are
//
// Like the archive importer this runs LOCALLY: the file never leaves the
// machine, only the derived rows do.
//
// Re-running is safe twice over. Each file's sha256 goes into
// `activity_sources.file_checksum`, which is uniquely indexed, and anything
// starting within five minutes of an activity already stored is treated as the
// same session — so the same ride exported from both Garmin and Strava lands
// once.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, statSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, basename, extname, dirname } from 'node:path';
import { homedir } from 'node:os';

import { parseFitSessions } from '../src/lib/ingest/fit.ts';
import { parseGpx, parseTcx } from '../src/lib/ingest/gpx.ts';
import { toRows, localDate, UnknownSportError } from '../src/lib/ingest/canonical.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY = has('--dry');
const KEEP = has('--keep');
const SPORT = flag('--sport', null);

const DEFAULT_DIR = process.env.ACTIVITY_DROP ?? join(homedir(), 'Desktop', 'activities');
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--sport') ?? DEFAULT_DIR;

const log = (...a) => console.error(...a);

if (!existsSync(target)) {
	log(`nothing at ${target}`);
	log('Drop .fit/.gpx/.tcx files there (or pass a folder), then re-run.');
	process.exit(1);
}

const PARSEABLE = /\.(fit|gpx|tcx)(\.gz)?$/i;
const isDir = statSync(target).isDirectory();
const files = isDir
	? readdirSync(target)
			.filter((f) => PARSEABLE.test(f))
			.sort()
			.map((f) => join(target, f))
	: [target];

if (!files.length) {
	log(`no .fit/.gpx/.tcx files in ${target}`);
	process.exit(0);
}

// A dry run still connects when it can: the thresholds below decide the
// exertion score, and a dry run that reported every ride on the MET floor
// because it never read them would be reassuring and wrong.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY && (!url || !key)) {
	log('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (node --env-file=.env ...). Or run with --dry.');
	process.exit(1);
}
const db = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

// The archive importer reconstructed an FTP/HR history into `athlete_thresholds`;
// this reads it rather than re-deriving anything, so a file added today is
// scored against the same numbers the rest of the table was.
let thresholdRows = [];
if (db) {
	const { data, error } = await db
		.from('athlete_thresholds')
		.select('effective_from, ftp_w, lthr_bpm, max_hr, rest_hr, threshold_pace_s_per_km, css_pace_s_per_100m, weight_kg')
		.order('effective_from', { ascending: true });
	if (error) throw new Error(`read athlete_thresholds: ${error.message}`);
	thresholdRows = data ?? [];
	if (!thresholdRows.length) log('WARNING: athlete_thresholds is empty — everything will score on the MET floor.');
}

/** The row in force on a date — §5's rule, the same one the app applies. */
function thresholdsOn(date) {
	let inForce = null;
	for (const r of thresholdRows) {
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

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** One canonical activity, or a reason there isn't one. */
function parseFile(path) {
	const name = basename(path);
	const raw = readFileSync(path);
	const buf = name.toLowerCase().endsWith('.gz') ? gunzipSync(raw) : raw;
	const kind = extname(name.replace(/\.gz$/i, '')).toLowerCase();
	const opts = SPORT ? { sport: SPORT } : {};

	if (kind === '.fit') {
		const sessions = parseFitSessions(buf, opts);
		if (!sessions.length) return { skip: 'not a FIT file, or no session in it' };
		// ponytail: a multisport recording needs the parent/leg structure the
		// archive importer builds (§5's parent_id), and one dropped triathlon
		// is not worth a second copy of it. Use activities:import for those.
		if (sessions.length > 1) return { skip: `${sessions.length} sessions (multisport) — use activities:import` };
		return { canonical: sessions[0] };
	}

	const xml = buf.toString('utf8');
	const canonical = kind === '.gpx' ? parseGpx(xml, opts) : parseTcx(xml, opts);
	if (!canonical) return { skip: 'no trackpoints with a clock' };
	return { canonical };
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

const FIVE_MINUTES = 5 * 60 * 1000;

/** Why this file is already in the database, or null. §4's first two rules:
 *  the exact file, then the same sport starting within five minutes. */
async function alreadyStored(checksum, canonical) {
	const { data: bySum, error: e1 } = await db
		.from('activity_sources')
		.select('activity_id')
		.eq('file_checksum', checksum)
		.maybeSingle();
	if (e1) throw new Error(`read activity_sources: ${e1.message}`);
	if (bySum) return `this exact file is activity ${bySum.activity_id}`;

	const t = Date.parse(canonical.started_at);
	const { data: near, error: e2 } = await db
		.from('activities')
		.select('id, sport, started_at')
		.gte('started_at', new Date(t - FIVE_MINUTES).toISOString())
		.lte('started_at', new Date(t + FIVE_MINUTES).toISOString());
	if (e2) throw new Error(`read activities: ${e2.message}`);
	const match = (near ?? []).find((a) => a.sport === canonical.sport);
	return match ? `activity ${match.id} already starts at ${match.started_at}` : null;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function insertActivity(built) {
	const { data, error } = await db.from('activities').insert(built.activity).select('id').single();
	if (error) throw new Error(`insert activities: ${error.message}`);
	const id = data.id;

	// Provenance first, as in the archive importer: an activity with no source
	// row is invisible to the dedupe above, so the next run would add it twice.
	try {
		const { error: e } = await db.from('activity_sources').insert({ ...built.source, activity_id: id });
		if (e) throw new Error(`insert activity_sources: ${e.message}`);
		if (built.streams) {
			const { error: es } = await db.from('activity_streams').insert({ activity_id: id, ...built.streams });
			if (es) throw new Error(`insert activity_streams: ${es.message}`);
		}
		if (built.laps?.length) {
			const { error: el } = await db.from('activity_laps').insert(built.laps.map((l) => ({ ...l, activity_id: id })));
			if (el) throw new Error(`insert activity_laps: ${el.message}`);
		}
	} catch (err) {
		await db.from('activities').delete().eq('id', id);
		throw err;
	}
	return id;
}

/** Out of the drop folder, so it stops being a to-do. */
function move(path) {
	const dir = join(isDir ? target : dirname(target), 'imported');
	mkdirSync(dir, { recursive: true });
	renameSync(path, join(dir, basename(path)));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const stats = { added: 0, duplicate: 0, skipped: 0, failed: 0 };

for (const path of files) {
	const name = basename(path);
	let parsed;
	try {
		parsed = parseFile(path);
	} catch (err) {
		stats.failed++;
		const hint = err instanceof UnknownSportError ? ' — or re-run with --sport <slug>' : '';
		log(`x ${name}: ${err.message}${hint}`);
		continue;
	}

	if (parsed.skip) {
		stats.skipped++;
		log(`- ${name}: ${parsed.skip}`);
		continue;
	}

	const canonical = parsed.canonical;
	const checksum = createHash('sha256').update(readFileSync(path)).digest('hex');
	const date = localDate(canonical.started_at, canonical.utc_offset_minutes ?? 0);
	const summary = `${canonical.sport} ${date} ${((canonical.distance_m ?? 0) / 1000).toFixed(1)}km`;
	const { activity, streams, laps } = toRows(canonical, thresholdsOn(date));
	const scored = `exertion ${activity.exertion ?? '-'} (${activity.exertion_method ?? 'none'})`;

	if (DRY) {
		stats.added++;
		log(`. ${name}: ${summary}, ${scored}`);
		continue;
	}

	const dup = await alreadyStored(checksum, canonical);
	if (dup) {
		stats.duplicate++;
		log(`= ${name}: ${dup}`);
		if (!KEEP) move(path);
		continue;
	}

	try {
		const id = await insertActivity({
			activity,
			streams,
			laps,
			source: {
				provider: 'file',
				file_name: name,
				file_checksum: checksum,
				// Above strava_archive's 80: this is what the device recorded,
				// not what Strava kept of it.
				fidelity: 90,
			},
		});
		stats.added++;
		log(`+ ${name}: ${summary} -> activity ${id}, ${scored}`);
		if (!KEEP) move(path);
	} catch (err) {
		stats.failed++;
		log(`x ${name}: ${err.message}`);
	}
}

log('');
log(
	`${DRY ? 'would add' : 'added'} ${stats.added}` +
		(stats.duplicate ? `, ${stats.duplicate} already stored` : '') +
		(stats.skipped ? `, ${stats.skipped} skipped` : '') +
		(stats.failed ? `, ${stats.failed} failed` : ''),
);
if (stats.failed) process.exitCode = 1;
