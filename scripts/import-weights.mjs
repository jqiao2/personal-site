// One-time backfill of body weight from an Apple Health export.
//
// The daily sync (an iOS Shortcut → POST /api/activities/weight) keeps weight
// current, but it only ever carries the latest reading. The history lives in
// Apple Health, and the only complete export of it is the big XML the Health
// app writes: Health → your profile → Export All Health Data → export.zip,
// which unzips to apple_health_export/export.xml. Every weigh-in is one line:
//
//   <Record type="HKQuantityTypeIdentifierBodyMass" ... unit="lb"
//           startDate="2024-03-15 07:30:00 -0700" ... value="165.2"/>
//
// This reads those, runs them through the SAME validation, per-day collapse and
// outlier guard the endpoint uses (imported from src/lib/athlete.ts, not
// re-implemented — see ts-hook.mjs), and upserts into body_weight. Idempotent:
// re-running overwrites each day with the same value, so a partial run resumes.
//
// The file is hundreds of MB, so it is streamed line by line and never leaves
// the machine — only the derived one-per-day weights are written.
//
// Usage:
//   node --import ./scripts/ts-hook.mjs --env-file=.env \
//     scripts/import-weights.mjs <path-to-export.xml> [--dry]
//
// Give it export.xml (unzip export.zip first — no zip dependency here). --dry
// parses and reports but writes nothing.

import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { parseWeighIns, flagOutliers } from '../src/lib/athlete.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const path = args.find((a) => !a.startsWith('--'));

if (!path) {
	console.error('Usage: … scripts/import-weights.mjs <path-to-export.xml> [--dry]');
	process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (--env-file=.env).');
	process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// --- parse the export ------------------------------------------------------
// One attribute reader, tolerant of attribute order. The BodyMass line carries
// value + unit + startDate on the opening tag whether or not the record has
// nested <MetadataEntry> children, so matching that line is enough.
const attr = (line, name) => line.match(new RegExp(`${name}="([^"]*)"`))?.[1];

const items = [];
let scanned = 0;
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
for await (const line of rl) {
	// Exact type — the closing quote keeps BodyMassIndex (BMI, unit "count") out.
	if (!line.includes('type="HKQuantityTypeIdentifierBodyMass"')) continue;
	scanned++;
	const rawValue = attr(line, 'value');
	const rawUnit = (attr(line, 'unit') ?? '').toLowerCase();
	const start = attr(line, 'startDate'); // "2024-03-15 07:30:00 -0700" — already local
	if (!rawValue || !start) continue;
	// Apple writes 'lb' or 'kg' for body mass; anything else is not a unit the
	// endpoint knows, so skip it loudly rather than guess.
	const unit = rawUnit.startsWith('lb') ? 'lb' : rawUnit === 'kg' ? 'kg' : null;
	if (!unit) {
		console.warn(`skipped a reading in unit "${rawUnit}" (want lb or kg): ${line.trim().slice(0, 80)}…`);
		continue;
	}
	items.push({ weight: Number(rawValue), unit, date: start });
}

if (items.length === 0) {
	console.error(`No BodyMass records found in ${path}. Is this the right export.xml?`);
	process.exit(1);
}

// Oldest first, so parseWeighIns's "last write for a day wins" keeps the LATEST
// reading of any day that was weighed more than once.
items.sort((a, b) => a.date.localeCompare(b.date));

const today = new Date().toISOString().slice(0, 10);
const parsed = parseWeighIns(items, today);
if ('error' in parsed) {
	console.error(`Parse failed: ${parsed.error}`);
	process.exit(1);
}

// --- outlier guard against the weights already accepted --------------------
const { data: existing, error: readErr } = await db
	.from('body_weight')
	.select('measured_on, weight_kg')
	.eq('ignored', false)
	.order('measured_on', { ascending: true });
if (readErr) {
	console.error(`Could not read existing weigh-ins: ${readErr.message}`);
	process.exit(1);
}

const rows = flagOutliers(existing ?? [], parsed.rows);
const flagged = rows.filter((r) => r.ignored);

console.log(
	`${scanned} BodyMass records → ${parsed.rows.length} days ` +
		`(${flagged.length} flagged as >10% outliers, kept but hidden).`,
);
console.log(`Range: ${rows[0].measured_on} … ${rows[rows.length - 1].measured_on}`);

// No process.exit() on the success paths: with the Supabase client's socket
// still closing, forcing exit trips a libuv assertion on Windows. Let the loop
// drain instead.
if (dry) {
	console.log('--dry: nothing written.');
	// Show each flagged reading against the accepted weight it was judged
	// against, so a real step-change can be told from a lone scale mis-read.
	const toLb = (kg) => (kg * 2.20462262).toFixed(1);
	let lastKg = existing?.length ? existing[existing.length - 1].weight_kg : null;
	for (const r of rows) {
		if (r.ignored) {
			const pct = lastKg ? (((r.weight_kg - lastKg) / lastKg) * 100).toFixed(1) : '?';
			console.log(`  flag ${r.measured_on}: ${toLb(r.weight_kg)} lb vs ${lastKg ? toLb(lastKg) : '—'} (${pct}%)`);
		} else {
			lastKg = r.weight_kg;
		}
	}
} else {
	const updated_at = new Date().toISOString();
	const { error: writeErr } = await db
		.from('body_weight')
		.upsert(
			rows.map((r) => ({ ...r, updated_at })),
			{ onConflict: 'measured_on' },
		);
	if (writeErr) {
		console.error(`Write failed: ${writeErr.message}`);
		process.exit(1);
	}
	console.log(`Wrote ${rows.length} days to body_weight.`);
}
