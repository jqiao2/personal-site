// Import a Strava bulk export — ACTIVITIES.md §4, step 1.
//
// This is the script that makes the activity log real. It reads the owner's
// own data export from a local directory and writes the whole history into
// Supabase: the activities, their streams, their laps, their provenance, the
// gear, and an FTP/HR threshold history reconstructed from what the devices
// themselves recorded.
//
// IT RUNS LOCALLY, ON PURPOSE. The archive is hundreds of megabytes and every
// outdoor track starts at the athlete's front door. Nothing here uploads a
// file anywhere: the parsing happens on this machine and only the derived rows
// go to the database. There is no server-side counterpart to this script and
// there should not be one.
//
// Usage:
//   node --import ./scripts/ts-hook.mjs --env-file=.env \
//     scripts/import-strava-archive.mjs <archive-dir> [options]
//
//   --dry              parse everything, print the summary, write nothing
//   --reset            delete everything this importer previously wrote, first
//   --limit N          only the N most recent activities (a rehearsal)
//   --rest-hr N        resting heart rate for the TRIMP rungs (default 50)
//   --skip-scan        don't re-derive thresholds; use what's already in the DB
//   --concurrency N    parallel writers (default 4)
//
// Re-running is safe: every activity is written with an `activity_sources` row
// carrying provider='strava_archive' and the Strava activity id as
// `external_id`, which is uniquely indexed. The script reads those ids first
// and skips anything already imported, so an interrupted run resumes.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';

import { parseFit, parseFitSessions } from '../src/lib/ingest/fit.ts';
import { parseGpx, parseTcx } from '../src/lib/ingest/gpx.ts';
import {
	parseCsv,
	indexHeader,
	readRow,
	csvRowToCanonical,
	mergeCanonical,
} from '../src/lib/ingest/strava-archive.ts';
import { toRows, localDate, UnknownSportError, sportFromStrava } from '../src/lib/ingest/canonical.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
/** Flags that take a value, so the value isn't mistaken for the archive path. */
const VALUE_FLAGS = new Set(['--limit', '--rest-hr', '--concurrency']);

const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

let ARCHIVE = null;
for (let i = 0; i < args.length; i++) {
	if (args[i].startsWith('--')) {
		if (VALUE_FLAGS.has(args[i])) i++;
		continue;
	}
	ARCHIVE = args[i];
	break;
}

const DRY = has('--dry');
const RESET = has('--reset');
const LIMIT = Number(flag('--limit', 0)) || 0;
const REST_HR = Number(flag('--rest-hr', 50));
const SKIP_SCAN = has('--skip-scan');
const CONCURRENCY = Number(flag('--concurrency', 4)) || 4;

if (!ARCHIVE || !existsSync(join(ARCHIVE, 'activities.csv'))) {
	console.error('Usage: node --import ./scripts/ts-hook.mjs --env-file=.env scripts/import-strava-archive.mjs <archive-dir> [--dry] [--limit N]');
	console.error('The directory must contain activities.csv (the root of an unzipped Strava export).');
	process.exit(1);
}

let db = null;
if (!DRY) {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (node --env-file=.env ...). Or run with --dry.');
		process.exit(1);
	}
	db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const log = (...a) => console.error(...a);

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

log(`reading ${join(ARCHIVE, 'activities.csv')}`);
const rows = parseCsv(readFileSync(join(ARCHIVE, 'activities.csv'), 'utf8'));
const idx = indexHeader(rows[0]);
const csvRows = rows
	.slice(1)
	.map((cells) => readRow(cells, idx))
	.filter(Boolean)
	// Newest first, so `--limit` gives a rehearsal on recent (richest) activities.
	.sort((a, b) => Number(b.activityId) - Number(a.activityId));

log(`${csvRows.length} activities in the csv`);

/** Reads `activities/12345.fit.gz` whatever its compression. */
function readActivityFile(relPath) {
	const full = join(ARCHIVE, relPath);
	if (!existsSync(full)) return null;
	const raw = readFileSync(full);
	const buf = relPath.endsWith('.gz') ? gunzipSync(raw) : raw;
	return { buf, bytes: raw.length, checksum: createHash('sha256').update(raw).digest('hex') };
}

const extOf = (p) => {
	const name = basename(p).toLowerCase().replace(/\.gz$/, '');
	if (name.endsWith('.fit')) return 'fit';
	if (name.endsWith('.gpx')) return 'gpx';
	if (name.endsWith('.tcx')) return 'tcx';
	return null;
};

// ---------------------------------------------------------------------------
// Pass A — learn the athlete's context from the files themselves
// ---------------------------------------------------------------------------
//
// Two things have to be known before a single exertion score can be computed,
// and neither is written down anywhere in the export:
//
// 1. THE UTC OFFSET. `local_date` is the column the whole week grid keys off
//    (§5), and Strava's csv states every date in UTC. A FIT file answers it
//    exactly, because it carries both a UTC and a local timestamp. GPX and TCX
//    carry UTC only — so those borrow the offset from the nearest activity in
//    time that did record one. That is better than a fixed home zone: the
//    offsets in this archive run at UTC-7/-8 through 2024 and UTC-4/-5 from
//    2025, because the athlete moved across the country, and a hardcoded
//    "America/Los_Angeles" would quietly misfile every recent evening ride.
//
// 2. THE THRESHOLDS. §3's cascade cannot reach its top rung without an FTP,
//    and its HR rungs need max/rest/LTHR. Nobody kept a training diary of
//    these, but the head units did: a FIT session records the `thresholdPower`
//    that was set on the device at the time, which is a real, dated FTP
//    history for free.

function scanFitFiles() {
	const offsets = []; // { t: epoch ms, offset: minutes }
	const ftps = []; // { t, ftp }
	const hrs = []; // { t, maxHr }

	const fitRows = csvRows.filter((r) => r.filename && extOf(r.filename) === 'fit');
	log(`scanning ${fitRows.length} fit files for offsets and thresholds...`);

	let done = 0;
	for (const row of fitRows) {
		done++;
		if (done % 200 === 0) log(`  ${done}/${fitRows.length}`);
		let file;
		try {
			file = readActivityFile(row.filename);
		} catch {
			continue;
		}
		if (!file) continue;
		try {
			const decoder = new Decoder(Stream.fromBuffer(file.buf));
			if (!decoder.isFIT()) continue;
			const { messages } = decoder.read({ mesgListener: undefined });
			const session = messages.sessionMesgs?.[0];
			const activity = messages.activityMesgs?.[0];
			if (!session?.startTime) continue;
			const t = new Date(session.startTime).getTime();

			if (activity && typeof activity.localTimestamp === 'number' && activity.timestamp) {
				const localMs = Date.UTC(1989, 11, 31) + activity.localTimestamp * 1000;
				const off = Math.round((localMs - new Date(activity.timestamp).getTime()) / 60000);
				// Same sanity rule as fit.ts: real offsets are within ±14h and land
				// on a quarter hour. This archive contains at least one file whose
				// localTimestamp is garbage (it decodes to -281669 hours).
				if (Math.abs(off) <= 14 * 60 && off % 15 === 0) offsets.push({ t, offset: off });
			}
			if (Number.isFinite(session.thresholdPower) && session.thresholdPower > 50) {
				ftps.push({ t, ftp: Math.round(session.thresholdPower) });
			}
			if (Number.isFinite(session.maxHeartRate) && session.maxHeartRate > 100) {
				hrs.push({ t, maxHr: Math.round(session.maxHeartRate) });
			}
		} catch {
			// A corrupt file costs us one data point, not the scan.
		}
	}
	offsets.sort((a, b) => a.t - b.t);
	ftps.sort((a, b) => a.t - b.t);
	hrs.sort((a, b) => a.t - b.t);
	log(`  offsets: ${offsets.length}, ftp readings: ${ftps.length}, hr readings: ${hrs.length}`);
	return { offsets, ftps, hrs };
}

/** The offset in force at the nearest activity that recorded one. */
function offsetNear(offsets, t) {
	if (!offsets.length) return null;
	let lo = 0;
	let hi = offsets.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid].t < t) lo = mid + 1;
		else hi = mid;
	}
	const after = offsets[lo];
	const before = offsets[Math.max(0, lo - 1)];
	return Math.abs(after.t - t) <= Math.abs(t - before.t) ? after.offset : before.offset;
}

/**
 * The device-reported FTP history, collapsed to one row per change.
 *
 * What each field is, and how much to trust it — this matters because §3 is
 * built on the claim that a number always travels with how it was got:
 *
 *   ftp_w    REAL. What the head unit had configured on that date.
 *   max_hr   REAL. The highest heart rate actually observed in the period.
 *   lthr_bpm ESTIMATED. 90% of max_hr — the standard field estimate, used
 *            because nobody here has done a lab test. Every `hrtss` score is
 *            only as good as this.
 *   rest_hr  ASSUMED. Not observable from activity files at all; --rest-hr.
 *   weight   REAL where the csv states it.
 *
 * The estimated and assumed ones are printed at the end of the run so they are
 * never silently load-bearing.
 */
/**
 * The athlete's real FTP history, from TrainerRoad (provided 2026-08-21).
 *
 * This REPLACES the FTP the head units reported. The device number is whatever
 * was configured on the unit at the time — often stale, sometimes disagreeing
 * between two units, and produced by Zwift/Wahoo auto-detection rather than by
 * a test. This list is the athlete's own record of what his threshold actually
 * was, including a `Ramp Test` provenance on several entries, and it reaches
 * back to 2016 where the devices only went back to 2021.
 *
 * `[effective_from, watts, how it was set]`, oldest last as TrainerRoad shows
 * it. Where two entries share a date, the one listed FIRST is the later of the
 * two (the list is newest-first), and it wins — `effective_from` is uniquely
 * indexed, so exactly one value can be in force on a day.
 */
const TRAINERROAD_FTP = [
	['2026-05-17', 258, 'AI FTP Detection'],
	['2026-04-16', 278, 'AI FTP Detection'],
	['2026-04-09', 289, 'Manual Entry'],
	['2026-03-19', 295, 'AI FTP Detection'],
	['2026-02-19', 279, 'AI FTP Detection'],
	['2026-01-22', 243, 'AI FTP Detection'],
	['2026-01-16', 240, 'AI FTP Detection'],
	['2025-11-06', 256, 'AI FTP Detection'],
	['2025-09-02', 258, 'FTP Adjustment'],
	['2025-07-17', 253, 'AI FTP Detection'],
	['2025-05-29', 250, 'AI FTP Detection'],
	['2025-05-01', 242, 'AI FTP Detection'],
	['2025-04-03', 239, 'AI FTP Detection'],
	['2025-02-12', 237, 'AI FTP Detection'],
	['2025-01-14', 230, 'Ramp Test'],
	['2023-01-24', 242, 'Ramp Test'],
	['2023-01-24', 250, 'Manual Entry'],
	['2023-01-17', 259, 'Other'],
	['2023-01-17', 217, 'Ramp Test'],
	['2022-11-30', 259, 'AI FTP Detection'],
	['2022-10-28', 251, 'Manual Entry'],
	['2021-08-03', 244, 'Manual Entry'],
	['2021-07-26', 212, 'Other'],
	['2016-11-04', 160, 'Other'],
];

function buildThresholds({ ftps, hrs }, weights) {
	if (TRAINERROAD_FTP.length) return buildThresholdsFromTrainerRoad({ hrs }, weights);
	if (!ftps.length) return [];

	// --- FTP: monthly median, then one row per real change -----------------
	// Raw device readings are noisy in a way that is not physiology: two head
	// units disagree (a Wahoo configured at 240 and a Garmin still on 200), and
	// auto-FTP detection nudges the number between rides. Taken raw, this
	// archive produces 230 → 200 → 240 inside eight days, which would make an
	// August ride score against a September FTP and back again. The median of a
	// month is stable against both, and a 5W gate keeps a genuine progression
	// while dropping the wobble.
	const byMonth = new Map();
	for (const { t, ftp } of ftps) {
		const month = new Date(t).toISOString().slice(0, 7);
		if (!byMonth.has(month)) byMonth.set(month, { t, values: [] });
		const bucket = byMonth.get(month);
		bucket.values.push(ftp);
		if (t < bucket.t) bucket.t = t;
	}

	const periods = [];
	for (const [, bucket] of [...byMonth].sort((a, b) => a[0].localeCompare(b[0]))) {
		const ftp = median(bucket.values);
		const last = periods[periods.length - 1];
		if (!last || Math.abs(last.ftp - ftp) >= 5) periods.push({ t: bucket.t, ftp });
	}

	// --- Heart rate: one stable pair for the whole history ------------------
	// Max HR is a slowly-declining physiological ceiling, not something that
	// changes between training blocks. Computing it per period says the athlete's
	// max fell to 168 in a quiet quarter and rose to 204 in a hard one — the
	// first is just "no hard efforts that month" and the second is a dropout
	// artifact, and since LTHR is derived from it, both would swing every hrtss
	// score in that window. So: one 99th percentile across everything observed,
	// which sits just under the true max and ignores the spikes.
	const observed = hrs.map((h) => h.maxHr).sort((a, b) => a - b);
	const maxHr = observed.length ? observed[Math.floor(observed.length * 0.99)] : null;
	const lthr = maxHr ? Math.round(maxHr * 0.9) : null;

	// One row per date, since effective_from is uniquely indexed — two periods
	// landing on the same day would collide on upsert and silently drop one.
	const byDate = new Map();
	for (const p of periods) {
		byDate.set(new Date(p.t).toISOString().slice(0, 10), {
			ftp_w: p.ftp,
			weight_kg: nearestValue(weights, p.t),
		});
	}

	return [...byDate]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([effective_from, v]) => ({
			effective_from,
			ftp_w: v.ftp_w,
			max_hr: maxHr,
			lthr_bpm: lthr,
			rest_hr: REST_HR,
			threshold_pace_s_per_km: null,
			css_pace_s_per_100m: null,
			weight_kg: v.weight_kg,
		}));
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The real FTP list, plus the heart rate figures the devices did observe.
 *
 * No smoothing here, unlike the device-derived path: these are stated values,
 * not a noisy signal, so every entry becomes a row exactly as given. Max HR
 * and LTHR still come from the archive because TrainerRoad's list says nothing
 * about them — see `buildThresholds` for why they are one figure for all
 * history rather than one per period.
 */
function buildThresholdsFromTrainerRoad({ hrs }, weights) {
	const observed = hrs.map((h) => h.maxHr).sort((a, b) => a - b);
	const maxHr = observed.length ? observed[Math.floor(observed.length * 0.99)] : null;
	const lthr = maxHr ? Math.round(maxHr * 0.9) : null;

	// Newest-first order means the first entry seen for a date is the later of
	// two set on the same day, and `effective_from` allows only one.
	const byDate = new Map();
	for (const [date, watts] of TRAINERROAD_FTP) {
		if (!byDate.has(date)) byDate.set(date, watts);
	}

	return [...byDate]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([effective_from, ftp_w]) => ({
			effective_from,
			ftp_w,
			max_hr: maxHr,
			lthr_bpm: lthr,
			rest_hr: REST_HR,
			threshold_pace_s_per_km: null,
			css_pace_s_per_100m: null,
			weight_kg: nearestValue(weights, Date.parse(`${effective_from}T12:00:00Z`)),
		}));
}

function nearestValue(points, t) {
	if (!points.length) return null;
	let best = null;
	let bestGap = Infinity;
	for (const p of points) {
		const gap = Math.abs(p.t - t);
		if (gap < bestGap) {
			bestGap = gap;
			best = p.value;
		}
	}
	return best;
}

/** The row in force on a date — the same rule the app uses (§5). */
function thresholdsOn(rowsByDate, date) {
	let inForce = null;
	for (const r of rowsByDate) {
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
// Gear
// ---------------------------------------------------------------------------

/**
 * The csv names gear by its display string ("Cervélo S3", "HOKA Speedgoat 4"),
 * and bikes.csv / shoes.csv carry the brand and model behind that string. Kind
 * comes from which file it appeared in, which is the only place that is stated
 * — guessing "shoes" from the sport would be wrong the first time he runs in
 * something logged as a bike.
 */
function readGearCatalog() {
	const catalog = new Map(); // display name → { kind, brand, model, name }

	const readCsv = (file, kind, nameCol, brandCol, modelCol) => {
		const path = join(ARCHIVE, file);
		if (!existsSync(path)) return;
		const parsed = parseCsv(readFileSync(path, 'utf8'));
		const header = parsed[0].map((h) => h.trim());
		for (const cells of parsed.slice(1)) {
			if (!cells.length || cells.every((c) => !c.trim())) continue;
			const get = (col) => (cells[header.indexOf(col)] ?? '').trim();
			const brand = get(brandCol);
			const model = get(modelCol);
			const named = get(nameCol);
			// Strava displays an unnamed piece of gear as "Brand Model".
			const display = named || [brand, model].filter(Boolean).join(' ');
			if (!display) continue;
			catalog.set(display, { kind, brand: brand || null, model: model || null, name: display });
			if (named) catalog.set([brand, model].filter(Boolean).join(' '), { kind, brand: brand || null, model: model || null, name: display });
		}
	};

	readCsv('bikes.csv', 'bike', 'Bike Name', 'Bike Brand', 'Bike Model');
	readCsv('shoes.csv', 'shoes', 'Shoe Name', 'Shoe Brand', 'Shoe Model');
	return catalog;
}

async function ensureGear(catalog, usedNames) {
	const byName = new Map();
	if (DRY) {
		let fake = 0;
		for (const name of usedNames) byName.set(name, --fake);
		return byName;
	}

	const { data: existing, error } = await db.from('activity_gear').select('id, name');
	if (error) throw new Error(`read activity_gear: ${error.message}`);
	for (const g of existing ?? []) byName.set(g.name, g.id);

	for (const name of usedNames) {
		if (byName.has(name)) continue;
		const meta = catalog.get(name);
		const { data, error: insErr } = await db
			.from('activity_gear')
			.insert({
				kind: meta?.kind ?? 'other',
				name,
				brand: meta?.brand ?? null,
				model: meta?.model ?? null,
				external_ids: { strava_archive: name },
			})
			.select('id')
			.single();
		if (insErr) throw new Error(`insert activity_gear ${name}: ${insErr.message}`);
		byName.set(name, data.id);
	}
	return byName;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const weights = csvRows
	.map((r) => ({ t: Date.parse(r.startedAt), value: Number(r.values['Athlete Weight']) }))
	.filter((w) => Number.isFinite(w.t) && Number.isFinite(w.value) && w.value > 0);

const context = SKIP_SCAN ? { offsets: [], ftps: [], hrs: [] } : scanFitFiles();

// Before anything is written — a reset after the thresholds were upserted
// would delete the rows this run just put there.
if (RESET && !DRY) await reset();

// --skip-scan means "trust what's already in the database". It must NOT rebuild
// the thresholds: with no scan there are no heart-rate readings, so a rebuild
// would write max_hr and lthr_bpm as null over good rows — and every HR-based
// score computed afterwards silently drops to the MET floor.
let thresholdRows = SKIP_SCAN ? [] : buildThresholds(context, weights);
if (!DRY && thresholdRows.length) {
	log(`writing ${thresholdRows.length} athlete_thresholds rows...`);
	for (const row of thresholdRows) {
		const { error } = await db.from('athlete_thresholds').upsert(row, { onConflict: 'effective_from' });
		if (error) throw new Error(`upsert athlete_thresholds ${row.effective_from}: ${error.message}`);
	}
}
if (SKIP_SCAN && !DRY) {
	const { data, error } = await db
		.from('athlete_thresholds')
		.select('effective_from, ftp_w, lthr_bpm, max_hr, rest_hr, threshold_pace_s_per_km, css_pace_s_per_100m, weight_kg')
		.order('effective_from');
	if (error) throw new Error(`read athlete_thresholds: ${error.message}`);
	thresholdRows = data ?? [];
}
thresholdRows.sort((a, b) => a.effective_from.localeCompare(b.effective_from));

/**
 * Remove everything a previous run of THIS importer wrote, so a corrected run
 * can replace it. Scoped by `provider = 'strava_archive'`, the same way
 * seed-activities.mjs scopes its own --reset by its marker: nothing that
 * arrived from a file drop, a device sync or by hand is touched, and neither
 * is any other section of the site.
 *
 * Also takes activities with NO source row at all. Those can only be the
 * wreckage of a run that died between writing an activity and writing its
 * provenance — they are invisible to the resume check below, so left alone
 * they would be silently duplicated on the next run.
 */
async function reset() {
	log('--reset: removing everything this importer previously wrote...');

	const { data: mine, error } = await db
		.from('activity_sources')
		.select('activity_id')
		.eq('provider', 'strava_archive');
	if (error) throw new Error(`read activity_sources: ${error.message}`);

	const ids = new Set((mine ?? []).map((s) => s.activity_id));

	const { data: all, error: e2 } = await db.from('activities').select('id');
	if (e2) throw new Error(`read activities: ${e2.message}`);
	const { data: sourced, error: e3 } = await db.from('activity_sources').select('activity_id');
	if (e3) throw new Error(`read activity_sources: ${e3.message}`);
	const hasSource = new Set((sourced ?? []).map((s) => s.activity_id));
	for (const a of all ?? []) if (!hasSource.has(a.id)) ids.add(a.id);

	// Children go with their parent through the FK cascade, but deleting a
	// parent whose child is also listed is harmless — the second delete simply
	// matches nothing.
	const list = [...ids];
	for (let i = 0; i < list.length; i += 200) {
		const { error: delErr } = await db.from('activities').delete().in('id', list.slice(i, i + 200));
		if (delErr) throw new Error(`delete activities: ${delErr.message}`);
	}

	// Gear and thresholds this importer created are rebuilt from the archive on
	// every run, so they go too rather than accumulating duplicates.
	const { error: gErr } = await db.from('activity_gear').delete().not('external_ids->>strava_archive', 'is', null);
	if (gErr) throw new Error(`delete activity_gear: ${gErr.message}`);
	const { error: tErr } = await db.from('athlete_thresholds').delete().gte('effective_from', '1900-01-01');
	if (tErr) throw new Error(`delete athlete_thresholds: ${tErr.message}`);

	log(`--reset: removed ${list.length} activities (streams, laps and sources cascade with them)`);
}

// Already imported? Skip. This is what makes an interrupted run resumable.
const alreadyImported = new Set();
if (!DRY) {
	for (let from = 0; ; from += 1000) {
		const { data, error } = await db
			.from('activity_sources')
			.select('external_id')
			.eq('provider', 'strava_archive')
			.range(from, from + 999);
		if (error) throw new Error(`read activity_sources: ${error.message}`);
		for (const s of data ?? []) if (s.external_id) alreadyImported.add(s.external_id);
		if (!data || data.length < 1000) break;
	}
	if (alreadyImported.size) log(`${alreadyImported.size} already imported — skipping those`);
}

const catalog = readGearCatalog();
const targets = (LIMIT ? csvRows.slice(0, LIMIT) : csvRows).filter((r) => !alreadyImported.has(r.activityId));
const gearNames = new Set(targets.map((r) => r.gear).filter(Boolean));
const gearIds = await ensureGear(catalog, gearNames);

// Group the rows that share one recorded file. Two csv rows backed by the same
// bytes are the same effort — see `buildGroup`. Grouping is by CONTENT, not by
// filename: a multisport export copies the identical file once per leg under a
// different name each time, so filenames alone would miss it.
const groups = (() => {
	const byChecksum = new Map();
	const singles = [];
	for (const row of targets) {
		let checksum = null;
		if (row.filename) {
			try {
				checksum = readActivityFile(row.filename)?.checksum ?? null;
			} catch {
				checksum = null;
			}
		}
		if (!checksum) {
			singles.push([row]);
			continue;
		}
		if (!byChecksum.has(checksum)) byChecksum.set(checksum, []);
		byChecksum.get(checksum).push(row);
	}
	return [...singles, ...byChecksum.values()];
})();

const sharedGroups = groups.filter((g) => g.length > 1);
if (sharedGroups.length) {
	log(`${sharedGroups.length} recordings are shared by more than one csv row (split rides and multisport events)`);
}

const stats = {
	imported: 0,
	skipped: 0,
	noFile: 0,
	unparsed: 0,
	byMethod: {},
	bySport: {},
	withRoute: 0,
	duplicatesMerged: 0,
	multisportEvents: 0,
	failures: [],
	unknownSports: new Set(),
};

/** Parse one csv row (plus its file, if any) into database rows.
 *  `parsedOverride` supplies an already-parsed canonical (one leg of a
 *  multisport file, say) so the file isn't decoded twice. */
function buildRows(row, parsedOverride) {
	let fromCsv;
	try {
		fromCsv = csvRowToCanonical(row);
	} catch (err) {
		if (err instanceof UnknownSportError) {
			stats.unknownSports.add(err.providerType);
			return null;
		}
		throw err;
	}
	if (!fromCsv) return null;

	let canonical = fromCsv;
	let file = null;
	let parsed = null;

	if (parsedOverride) {
		file = parsedOverride.file ?? null;
		parsed = parsedOverride.canonical;
		canonical = mergeCanonical(parsed, fromCsv);
	} else if (row.filename) {
		const kind = extOf(row.filename);
		file = readActivityFile(row.filename);
		if (!file) {
			stats.noFile++;
		} else {
			try {
				if (kind === 'fit') parsed = parseFit(file.buf, { sport: fromCsv.sport });
				else if (kind === 'gpx') parsed = parseGpx(file.buf.toString('utf8'), { sport: fromCsv.sport });
				else if (kind === 'tcx') parsed = parseTcx(file.buf.toString('utf8'), { sport: fromCsv.sport });
			} catch (err) {
				stats.failures.push(`${row.activityId} (${kind}): ${err.message}`);
			}
			if (parsed) canonical = mergeCanonical(parsed, fromCsv);
			else stats.unparsed++;
		}
	} else {
		stats.noFile++;
	}

	// The offset: exact from the file where it recorded one, otherwise borrowed
	// from the nearest activity that did (see Pass A).
	if (canonical.utc_offset_minutes == null) {
		canonical.utc_offset_minutes = offsetNear(context.offsets, Date.parse(canonical.started_at));
	}

	const date = localDate(canonical.started_at, canonical.utc_offset_minutes ?? 0);
	const { activity, streams, laps } = toRows(canonical, thresholdsOn(thresholdRows, date));

	if (row.gear && gearIds.has(row.gear)) activity.gear_id = gearIds.get(row.gear);

	const source = {
		provider: 'strava_archive',
		external_id: row.activityId,
		external_url: `https://www.strava.com/activities/${row.activityId}`,
		file_name: row.filename ?? null,
		file_checksum: file?.checksum ?? null,
		// The archive is the athlete's own export, so it outranks anything
		// mirrored through an API later — §4's dedupe reads this.
		fidelity: parsed ? 80 : 40,
		raw: row.values,
	};

	return { activity, streams, laps, source };
}

// ---------------------------------------------------------------------------
// Groups — several csv rows sharing one recording
// ---------------------------------------------------------------------------
//
// The archive contains two cases where N csv rows are backed by ONE recorded
// file, and both were silently wrong before this existed. This is §4's dedupe
// section, which the first pass skipped as speculative — wrongly, since the
// data has always had both.
//
// 1. A SPLIT RIDE. One upload, renamed into two or three Strava activities
//    ("Ride from DR" / "Ride to DR"). Each csv row carries the WHOLE ride's
//    distance and power, so importing all of them counts a 66km ride twice.
//    One activity is stored; every Strava id is kept as its own
//    `activity_sources` row, which is exactly what that table is for.
//
// 2. A MULTISPORT EVENT. A triathlon is one file with five sessions, and the
//    export copies that whole file once per leg under five filenames. Reading
//    session[0] each time gave all five legs the swim's numbers. Now the file
//    is parsed into its sessions and stored as a `triathlon` parent with the
//    legs as children (§5's parent_id/leg), transitions included.

/** Longest common prefix of the leg titles — "Sunny 70.3 Swim", "Sunny 70.3
 *  Bike"… names the parent "Sunny 70.3" without anybody typing it. */
function commonPrefix(titles) {
	const usable = titles.filter(Boolean);
	if (!usable.length) return null;
	let prefix = usable[0];
	for (const t of usable.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
		prefix = prefix.slice(0, i);
	}
	prefix = prefix.replace(/[\s\-—–:]+$/, '').trim();
	return prefix.length >= 3 ? prefix : null;
}

/** The cascade's rungs, weakest last — a parent is only as trustworthy as its
 *  least-trustworthy leg, so that is the method and confidence it reports. */
const METHOD_RANK = { tss: 0, hrtss: 1, ptss: 2, avghr: 3, met: 4 };
const CONFIDENCE_RANK = { measured: 0, estimated: 1, assumed: 2 };

function buildGroup(rows) {
	if (rows.length === 1) {
		const built = buildRows(rows[0]);
		return built ? [built] : [];
	}

	// Every row here shares one file, so read and parse it once.
	const withFile = rows.find((r) => r.filename);
	const file = withFile ? readActivityFile(withFile.filename) : null;
	if (!file || extOf(withFile.filename) !== 'fit') {
		// Not a FIT file (or missing): treat as duplicates of the first row.
		return buildDuplicates(rows);
	}

	let sessions = [];
	try {
		sessions = parseFitSessions(file.buf, { sport: csvSportOf(rows[0]) ?? 'other' });
	} catch (err) {
		stats.failures.push(`${rows[0].activityId}: ${err.message}`);
	}

	if (sessions.length <= 1) return buildDuplicates(rows, file, sessions[0]);
	return buildMultisport(rows, file, sessions);
}

function csvSportOf(row) {
	try {
		return sportFromStrava(row.type);
	} catch {
		return null;
	}
}

/** One activity, every Strava id kept as provenance. */
function buildDuplicates(rows, file, canonical) {
	const primary = rows[0];
	const built = buildRows(primary, canonical ? { canonical, file } : undefined);
	if (!built) return [];

	built.extraSources = rows.slice(1).map((r) => ({
		provider: 'strava_archive',
		external_id: r.activityId,
		external_url: `https://www.strava.com/activities/${r.activityId}`,
		file_name: r.filename ?? null,
		// Only one row may carry the checksum — it is uniquely indexed, and
		// these are all the same bytes. The id is what makes each row findable.
		file_checksum: null,
		fidelity: 40,
		raw: r.values,
	}));
	stats.duplicatesMerged += rows.length - 1;
	return [built];
}

/** A `triathlon` parent with its legs as children. */
function buildMultisport(rows, file, sessions) {
	const pool = rows.slice();
	const eventName = commonPrefix(rows.map((r) => r.name)) ?? 'Triathlon';
	let transitionSeen = 0;

	const legs = sessions.map((canonical, i) => {
		// Match this leg to the csv row that describes it, by sport, so the
		// athlete's own leg titles survive. Transitions are Strava "Workout"
		// rows and are taken in order.
		const wanted = canonical.sport;
		let matchIdx = pool.findIndex((r) => csvSportOf(r) === wanted);
		if (matchIdx < 0 && wanted === 'transition') matchIdx = pool.findIndex((r) => csvSportOf(r) === 'strength');
		if (matchIdx < 0 && wanted === 'open_water_swim') matchIdx = pool.findIndex((r) => csvSportOf(r) === 'swim');
		if (matchIdx < 0 && wanted === 'ride') matchIdx = pool.findIndex((r) => csvSportOf(r) === 'ride');
		const row = matchIdx >= 0 ? pool.splice(matchIdx, 1)[0] : rows[Math.min(i, rows.length - 1)];

		const built = buildRows(row, { canonical, file });
		if (built) {
			built.activity.leg = i + 1;
			// The file's own sport is the authority for a leg (see fit.ts).
			built.activity.sport = canonical.sport;
			built.activity.sub_sport = canonical.sub_sport ?? null;

			// Transitions are named by POSITION, not by which csv row matched.
			// Strava types both T1 and T2 as "Workout", so they are
			// interchangeable to the matcher above — and it duly labelled one
			// event's first transition "T2". The file's session order is the
			// truth: the first transition of a triathlon is T1.
			if (canonical.sport === 'transition') {
				transitionSeen++;
				built.activity.title = `${eventName} T${transitionSeen}`;
			}
		}
		return built;
	}).filter(Boolean);

	if (!legs.length) return [];

	// The parent: the whole day, summed. Its route is every leg's track laid
	// end to end, which is what the day actually looked like.
	const sum = (key) => legs.reduce((t, l) => t + (Number(l.activity[key]) || 0), 0);
	const track = sessions.flatMap((s) => s.streams?.latlng ?? []);
	const first = legs[0].activity;
	const last = legs[legs.length - 1].activity;
	const endMs = Date.parse(last.started_at) + (last.elapsed_seconds ?? 0) * 1000;

	const parentCanonical = {
		sport: 'triathlon',
		title: eventName,
		started_at: first.started_at,
		utc_offset_minutes: first.utc_offset_minutes,
		elapsed_seconds: Math.max(1, Math.round((endMs - Date.parse(first.started_at)) / 1000)),
		moving_seconds: sum('moving_seconds') || null,
		distance_m: sum('distance_m') || null,
		elevation_gain_m: sum('elevation_gain_m') || null,
		avg_hr: Math.round(sum('avg_hr') / legs.length) || null,
		max_hr: Math.max(...legs.map((l) => Number(l.activity.max_hr) || 0)) || null,
		calories: sum('calories') || null,
		device_name: first.device_name,
		// Geometry only — no per-sample arrays on the parent, since each leg
		// already holds its own and they would be stored twice.
		streams: track.length ? { latlng: track } : undefined,
	};

	const parent = buildRowsFromCanonical(parentCanonical, rows[0], file);
	// Exertion is the sum of the legs, each scored by its own sport — a
	// triathlon has no single method of its own, and the MET floor for
	// "triathlon" would be a worse answer than adding up three real ones.
	const weakest = legs.reduce((w, l) =>
		CONFIDENCE_RANK[l.activity.exertion_confidence] > CONFIDENCE_RANK[w.activity.exertion_confidence] ||
		(l.activity.exertion_confidence === w.activity.exertion_confidence &&
			METHOD_RANK[l.activity.exertion_method] > METHOD_RANK[w.activity.exertion_method])
			? l
			: w,
	);
	parent.activity.exertion = Number(legs.reduce((t, l) => t + (Number(l.activity.exertion) || 0), 0).toFixed(2));
	parent.activity.exertion_method = weakest.activity.exertion_method;
	parent.activity.exertion_confidence = weakest.activity.exertion_confidence;
	parent.activity.intensity_factor = null;
	parent.streams = null;
	parent.laps = [];

	// Every leg's Strava id hangs off the parent too, so any of the five links
	// still resolves to this day.
	parent.extraSources = rows.slice(1).map((r) => ({
		provider: 'strava_archive',
		external_id: r.activityId,
		external_url: `https://www.strava.com/activities/${r.activityId}`,
		file_name: r.filename ?? null,
		file_checksum: null,
		fidelity: 40,
		raw: r.values,
	}));
	// …and the legs themselves carry no source row, because their ids are on
	// the parent. Recording each id twice would break the unique index.
	for (const leg of legs) leg.source = null;

	parent.children = legs;
	stats.multisportEvents++;
	return [parent];
}

/** `buildRows` for a canonical with no csv row of its own (the parent). */
function buildRowsFromCanonical(canonical, row, file) {
	const date = localDate(canonical.started_at, canonical.utc_offset_minutes ?? 0);
	const { activity, streams, laps } = toRows(canonical, thresholdsOn(thresholdRows, date));
	return {
		activity,
		streams,
		laps,
		source: {
			provider: 'strava_archive',
			external_id: row.activityId,
			external_url: `https://www.strava.com/activities/${row.activityId}`,
			file_name: row.filename ?? null,
			file_checksum: file?.checksum ?? null,
			fidelity: 80,
			raw: row.values,
		},
	};
}

async function insertActivity(built, parentId) {
	const payload = parentId ? { ...built.activity, parent_id: parentId } : built.activity;
	const { data, error } = await db.from('activities').insert(payload).select('id').single();
	if (error) throw new Error(`insert activities: ${error.message}`);
	const id = data.id;

	// Provenance FIRST after the row itself. If it fails, the activity is
	// removed again rather than left behind with no source — an activity with
	// no `activity_sources` row is invisible to the resume check, so the next
	// run would import it a second time.
	try {
		const sources = [
			...(built.source ? [{ ...built.source, activity_id: id }] : []),
			...(built.extraSources ?? []).map((s) => ({ ...s, activity_id: id })),
		];
		if (sources.length) {
			const { error: e } = await db.from('activity_sources').insert(sources);
			if (e) throw new Error(`insert activity_sources: ${e.message}`);
		}

		if (built.streams) {
			const { error: e } = await db.from('activity_streams').insert({ activity_id: id, ...built.streams });
			if (e) throw new Error(`insert activity_streams: ${e.message}`);
		}
		if (built.laps?.length) {
			const { error: e } = await db.from('activity_laps').insert(built.laps.map((l) => ({ ...l, activity_id: id })));
			if (e) throw new Error(`insert activity_laps: ${e.message}`);
		}
	} catch (err) {
		await db.from('activities').delete().eq('id', id);
		throw err;
	}
	return id;
}

async function writeOne(built) {
	const parentId = await insertActivity(built, null);
	for (const child of built.children ?? []) await insertActivity(child, parentId);
}

// ponytail: one activity per round trip rather than a batch insert. A bulk
// insert would have to trust that PostgREST returns the generated ids in the
// order the rows were sent, and getting that wrong attaches a ride's gps track
// to somebody else's swim — permanently, and silently. This runs once. The
// worker pool below is what makes it finish in minutes anyway.
async function run() {
	const queue = groups.slice();
	let active = 0;
	let done = 0;

	const count = (built) => {
		stats.imported++;
		const m = built.activity.exertion_method ?? 'none';
		stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;
		stats.bySport[built.activity.sport] = (stats.bySport[built.activity.sport] ?? 0) + 1;
		if (built.activity.route_path) stats.withRoute++;
		for (const child of built.children ?? []) count(child);
	};

	await new Promise((resolve, reject) => {
		const next = () => {
			if (!queue.length && active === 0) return resolve();
			while (active < CONCURRENCY && queue.length) {
				const group = queue.shift();
				active++;
				(async () => {
					let builts = [];
					try {
						builts = buildGroup(group);
					} catch (err) {
						stats.failures.push(`${group[0].activityId}: ${err.message}`);
					}
					if (!builts.length) {
						stats.skipped += group.length;
					}
					for (const built of builts) {
						try {
							if (!DRY) await writeOne(built);
							count(built);
						} catch (err) {
							stats.failures.push(`${group[0].activityId}: ${err.message}`);
							stats.skipped++;
						}
					}
					active--;
					done++;
					if (done % 100 === 0) log(`  ${done}/${groups.length} (${stats.imported} written)`);
					next();
				})().catch(reject);
			}
		};
		next();
	});
}

log(`${DRY ? 'parsing' : 'importing'} ${targets.length} activities in ${groups.length} groups, concurrency ${CONCURRENCY}...`);
const startedAt = Date.now();
await run();
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

log('');
log(`${DRY ? 'parsed' : 'imported'} ${stats.imported} activities in ${seconds}s`);
log(`  with a route:      ${stats.withRoute}`);
log(`  no file in archive: ${stats.noFile}`);
log(`  file unparseable:   ${stats.unparsed}`);
log(`  skipped:            ${stats.skipped}`);
log('');
log('exertion method (§3 cascade):');
for (const [m, c] of Object.entries(stats.byMethod).sort((a, b) => b[1] - a[1])) log(`  ${m.padEnd(8)} ${c}`);
log('');
log('sports:');
for (const [s, c] of Object.entries(stats.bySport).sort((a, b) => b[1] - a[1])) log(`  ${s.padEnd(16)} ${c}`);

if (thresholdRows.length) {
	log('');
	log(`athlete_thresholds — ${thresholdRows.length} periods:`);
	for (const t of thresholdRows.slice(-6)) {
		log(`  ${t.effective_from}  ftp ${t.ftp_w ?? '—'}W  maxHR ${t.max_hr ?? '—'}  lthr ${t.lthr_bpm ?? '—'}  rest ${t.rest_hr ?? '—'}`);
	}
	log('');
	log('  ftp_w and max_hr are REAL (device-reported / observed).');
	log(`  lthr_bpm is ESTIMATED at 90% of max_hr, and rest_hr is ASSUMED (${REST_HR}).`);
	log('  Both feed every hrtss/avghr score — correct them in athlete_thresholds');
	log('  and the whole table can be recomputed, since exertion is a pure function.');
}

if (stats.unknownSports.size) {
	log('');
	log('UNKNOWN SPORTS — these activities were skipped rather than filed as "other":');
	for (const s of stats.unknownSports) log(`  ${s}`);
	log('  Add a slug to src/lib/sports.ts and STRAVA_SPORTS in canonical.ts, then re-run.');
}

if (stats.failures.length) {
	log('');
	log(`${stats.failures.length} failures:`);
	for (const f of stats.failures.slice(0, 25)) log(`  ${f}`);
	if (stats.failures.length > 25) log(`  … and ${stats.failures.length - 25} more`);
}
