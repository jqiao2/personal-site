// One-time backfill: parse medium / theater / format out of the historical diary
// TAGS into the real columns added by migration 0010.
//
// Model (from the data):
//   - A log is a THEATER viewing if it has a "theater" tag OR any venue tag.
//     Its venue comes from the venue tag; its format from the format tag(s).
//   - "plane" is its own medium (no venue/format).
//   - Everything else stays a tag — including "bike" (watched while biking is a
//     viewing *context*, not a medium; the real medium, computer vs TV, is
//     unknown), companion initials, project tags, and emoji.
//
// The consumed tags (theater / venue / format / plane / bike) are stripped from
// the log afterwards, and any tag left with no links is deleted. Idempotent:
// logs that already have a medium set are skipped, so a re-run is a no-op.
//
//   node --env-file=.env scripts/backfill-medium.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

// --- translation maps (confirm/adjust before the real run) -------------------

// venue tag -> { name, city }. city groups them on a future "theaters visited" map.
const THEATERS = {
	// NYC
	'34th': { name: 'AMC 34th Street 14', city: 'New York, NY' },
	'lincoln square': { name: 'AMC Lincoln Square 13', city: 'New York, NY' },
	empire: { name: 'AMC Empire 25', city: 'New York, NY' },
	'kips bay': { name: 'AMC Kips Bay 15', city: 'New York, NY' },
	'magic johnson': { name: 'AMC Magic Johnson Harlem 9', city: 'New York, NY' },
	'19th': { name: 'AMC 19th St East 6', city: 'New York, NY' }, // UNCERTAIN
	'angelika film center': { name: 'Angelika Film Center', city: 'New York, NY' },
	'cinema village': { name: 'Cinema Village', city: 'New York, NY' },
	'ifc center': { name: 'IFC Center', city: 'New York, NY' },
	'walter reade': { name: 'Walter Reade Theater', city: 'New York, NY' },
	'new plaza cinema': { name: 'New Plaza Cinema', city: 'New York, NY' },
	redstone: { name: 'Redstone Theater (Museum of the Moving Image)', city: 'Astoria, NY' },
	// San Diego
	utc: { name: 'AMC UTC 14', city: 'San Diego, CA' }, // UNCERTAIN (Westfield UTC)
	'la jolla': { name: 'AMC La Jolla 12', city: 'San Diego, CA' }, // UNCERTAIN
	'fashion valley': { name: 'AMC Fashion Valley 18', city: 'San Diego, CA' },
	'mission valley': { name: 'AMC Mission Valley 20', city: 'San Diego, CA' },
	'mira mesa': { name: 'AMC Mira Mesa 18', city: 'San Diego, CA' },
	'plaza bonita': { name: 'AMC Plaza Bonita 14', city: 'National City, CA' },
	// LA
	'vista theatre': { name: 'Vista Theatre', city: 'Los Angeles, CA' },
	// NB: "mmdr" is NOT a theater — it's the "minions-and-monsters-death-race"
	// viewing challenge (like "oscar-death-race-2025"), so it stays a plain tag and
	// its logs get no medium.
};

// format tag -> canonical name.
const FORMATS = {
	imax: 'IMAX',
	'dolby cinema': 'Dolby Cinema',
	'35mm': '35mm',
	'70mm': '70mm',
	'3d': '3D',
	vistavision: 'VistaVision',
};

// Non-theater mediums that live as a standalone tag. ("bike" is intentionally NOT
// here — it's a viewing context, not a medium, so it stays a tag.)
const STANDALONE_MEDIUMS = { plane: 'plane' };

// Combine multiple format tags on one viewing into a single canonical format.
function canonFormat(fmts) {
	const set = new Set(fmts);
	if (set.has('IMAX') && set.has('70mm')) return 'IMAX 70mm';
	if (set.has('IMAX') && set.has('3D')) return 'IMAX 3D';
	return fmts[0] ?? null;
}

const venueKey = (t) => `${t.name}||${t.city ?? ''}`;

// --- load every live log with its tags ---------------------------------------
async function loadLogs() {
	const PAGE = 1000;
	const out = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await sb
			.from('logs')
			.select('id, medium, log_tags(tag_id, tags(name))')
			.is('deleted_at', null)
			.order('id', { ascending: true })
			.range(offset, offset + PAGE - 1);
		if (error) throw error;
		out.push(...data);
		if (data.length < PAGE) break;
	}
	return out;
}

async function main() {
	console.log(`mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}\n`);
	const logs = await loadLogs();
	console.log(`live logs: ${logs.length}`);

	// Plan each log.
	const plans = []; // { logId, medium, venue|null, format|null, consumeTagIds[] }
	const usedTheaters = new Map(); // key -> {name,city}
	const usedFormats = new Set();
	const multiVenue = [];
	let alreadyDone = 0;

	for (const l of logs) {
		if (l.medium) {
			alreadyDone++;
			continue; // idempotent: skip already-backfilled logs
		}
		const tagEntries = (l.log_tags ?? []).map((lt) => ({
			id: lt.tag_id,
			name: lt.tags?.name ?? '',
		}));
		const names = tagEntries.map((t) => t.name);

		const venueTags = tagEntries.filter((t) => THEATERS[t.name]);
		const formatTags = tagEntries.filter((t) => FORMATS[t.name]);
		const isTheater = names.includes('theater') || venueTags.length > 0;

		let medium = null;
		let venue = null;
		let format = null;
		const consume = [];

		if (isTheater) {
			medium = 'theater';
			if (venueTags.length > 1) multiVenue.push({ logId: l.id, venues: venueTags.map((t) => t.name) });
			if (venueTags[0]) {
				venue = THEATERS[venueTags[0].name];
				usedTheaters.set(venueKey(venue), venue);
			}
			const fmts = formatTags.map((t) => FORMATS[t.name]);
			format = canonFormat(fmts);
			if (format) usedFormats.add(format);
			// consume the "theater" tag + venue tags + format tags
			for (const t of tagEntries) {
				if (t.name === 'theater' || THEATERS[t.name] || FORMATS[t.name]) consume.push(t.id);
			}
		} else if (STANDALONE_MEDIUMS[names.find((n) => STANDALONE_MEDIUMS[n])]) {
			const key = names.find((n) => STANDALONE_MEDIUMS[n]);
			medium = STANDALONE_MEDIUMS[key];
			for (const t of tagEntries) if (t.name === key) consume.push(t.id);
		} else {
			continue; // no medium info on this log
		}

		plans.push({ logId: l.id, medium, venue, format, consumeTagIds: [...new Set(consume)] });
	}

	console.log(`already backfilled (skipped): ${alreadyDone}`);
	console.log(`logs to update: ${plans.length}`);
	console.log(`  theater: ${plans.filter((p) => p.medium === 'theater').length}`);
	console.log(`  plane:   ${plans.filter((p) => p.medium === 'plane').length}`);
	console.log(`  bike:    ${plans.filter((p) => p.medium === 'bike').length}`);
	console.log(`distinct theaters: ${usedTheaters.size} | distinct formats: ${usedFormats.size}`);
	if (multiVenue.length) {
		console.log(`\n⚠ logs with >1 venue tag (used the first; review):`);
		for (const m of multiVenue) console.log(`   log ${m.logId}: [${m.venues.join(', ')}]`);
	}

	if (DRY_RUN) {
		console.log('\nSample plans:');
		for (const p of plans.slice(0, 8)) console.log('  ', JSON.stringify(p));
		console.log('\n--dry-run: no writes.');
		return;
	}

	// --- seed theaters + formats, map to ids ---
	const theaterRows = [...usedTheaters.values()];
	if (theaterRows.length) {
		const { error } = await sb.from('theaters').upsert(theaterRows, { onConflict: 'name,city' });
		if (error) throw new Error(`theaters upsert: ${error.message}`);
	}
	const formatRows = [...usedFormats].map((name) => ({ name }));
	if (formatRows.length) {
		const { error } = await sb.from('formats').upsert(formatRows, { onConflict: 'name' });
		if (error) throw new Error(`formats upsert: ${error.message}`);
	}

	const { data: thData, error: thErr } = await sb.from('theaters').select('id, name, city');
	if (thErr) throw thErr;
	const theaterId = new Map(thData.map((t) => [`${t.name}||${t.city ?? ''}`, t.id]));
	const { data: fmData, error: fmErr } = await sb.from('formats').select('id, name');
	if (fmErr) throw fmErr;
	const formatId = new Map(fmData.map((f) => [f.name, f.id]));

	// --- update logs + strip consumed tags ---
	let updated = 0;
	let linksRemoved = 0;
	for (const p of plans) {
		const patch = {
			medium: p.medium,
			theater_id: p.venue ? (theaterId.get(venueKey(p.venue)) ?? null) : null,
			format_id: p.format ? (formatId.get(p.format) ?? null) : null,
		};
		const { error: uErr } = await sb.from('logs').update(patch).eq('id', p.logId);
		if (uErr) throw new Error(`update log ${p.logId}: ${uErr.message}`);
		updated++;

		if (p.consumeTagIds.length) {
			const { error: dErr, count } = await sb
				.from('log_tags')
				.delete({ count: 'exact' })
				.eq('log_id', p.logId)
				.in('tag_id', p.consumeTagIds);
			if (dErr) throw new Error(`strip tags log ${p.logId}: ${dErr.message}`);
			linksRemoved += count ?? 0;
		}
		if (updated % 100 === 0) process.stdout.write(`\r  updated ${updated}/${plans.length}`);
	}
	process.stdout.write(`\r  updated ${updated}/${plans.length}\n`);
	console.log(`log_tags links removed: ${linksRemoved}`);

	// --- delete now-orphan medium/venue/format tags ---
	const consumedNames = [
		'theater',
		...Object.keys(STANDALONE_MEDIUMS),
		...Object.keys(THEATERS),
		...Object.keys(FORMATS),
	];
	const { data: orphans, error: oErr } = await sb
		.from('tags')
		.select('id, name, log_tags(log_id)')
		.in('name', consumedNames);
	if (oErr) throw oErr;
	const toDelete = orphans.filter((t) => (t.log_tags ?? []).length === 0).map((t) => t.id);
	if (toDelete.length) {
		const { error: delErr } = await sb.from('tags').delete().in('id', toDelete);
		if (delErr) throw new Error(`delete orphan tags: ${delErr.message}`);
	}
	console.log(`orphan tags deleted: ${toDelete.length}`);

	console.log(`\n✓ Backfill complete. logs updated=${updated}`);
}

main().catch((e) => {
	console.error('\n✗', e.message || e);
	process.exit(1);
});
