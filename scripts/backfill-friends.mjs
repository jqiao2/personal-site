// One-time backfill: turn the historical companion-initial TAGS into real
// `friends` + `log_friends` rows (migration 0013).
//
// backfill-medium.mjs deliberately left these alone — "everything else stays a
// tag … companion initials, project tags, and emoji" — because there was nowhere
// better to put them yet. Migration 0013 is that place, so this finishes the job.
//
// Model (from the data):
//   - Each initial below is one person. Everything else stays a tag: 'bike' (a
//     viewing context, per 0010), 'oscar-death-race-2025' (a project), '🍃', and
//     'mmdr' — four letters across a single July 1–5 run of classics, so it reads
//     as a project tag rather than anyone's initials.
//
// The consumed initial tags are stripped from the log afterwards, and any tag
// left with no links is deleted — same contract as backfill-medium.mjs, so a
// name never lingers in both places. Idempotent: a log that already has the
// friend linked is skipped, so a re-run is a no-op.
//
//   node --env-file=.env scripts/backfill-friends.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

// --- translation map (confirmed by Jason) ------------------------------------
// initial tag -> full name. Anything not listed here is left as a tag.
const FRIENDS = {
	ap: 'Athena Parker',
	ch: 'Cooper Harris',
	cl: 'Christina Li',
	kl: 'Kristen Lau',
	ks: 'Kam Sedigh',
	rr: 'Ryan Ruiz',
	sm: 'Sean Mastrodimos',
	ss: 'Sarah Sek',
	sw: 'Spencer Whitney',
};

// --- load every live log with its tags + already-linked friends --------------
async function loadLogs() {
	const PAGE = 1000;
	const out = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await sb
			.from('logs')
			.select('id, log_tags(tag_id, tags(name)), log_friends(friend_id, friends(name))')
			.is('deleted_at', null)
			.order('id', { ascending: true })
			.range(offset, offset + PAGE - 1);
		if (error) throw error;
		out.push(...data);
		if (data.length < PAGE) break;
	}
	return out;
}

/** Resolve every needed name to a friend id, creating the missing ones. Matches
 * case-insensitively, the same rule the app's resolveFriendIds uses. */
async function resolveFriendIds(names) {
	const { data: existing, error } = await sb.from('friends').select('id, name');
	if (error) throw error;

	const idByKey = new Map();
	for (const f of existing ?? []) idByKey.set(f.name.trim().toLowerCase(), f.id);

	const missing = names.filter((n) => !idByKey.has(n.toLowerCase()));
	if (missing.length > 0) {
		console.log(`friends to create: ${missing.join(', ')}`);
		if (!DRY_RUN) {
			const { data: made, error: insErr } = await sb
				.from('friends')
				.insert(missing.map((name) => ({ name })))
				.select('id, name');
			if (insErr) throw insErr;
			for (const f of made ?? []) idByKey.set(f.name.trim().toLowerCase(), f.id);
		}
	}
	return idByKey;
}

async function main() {
	console.log(`mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}\n`);
	const logs = await loadLogs();
	console.log(`live logs: ${logs.length}`);

	// Plan each log: which friends to link, which tag links to strip.
	const plans = []; // { logId, names[], consumeTagIds[] }
	let alreadyDone = 0;

	for (const l of logs) {
		const tagEntries = (l.log_tags ?? []).map((lt) => ({
			id: lt.tag_id,
			name: lt.tags?.name ?? '',
		}));
		const hits = tagEntries.filter((t) => FRIENDS[t.name]);
		if (hits.length === 0) continue;

		const linked = new Set((l.log_friends ?? []).map((lf) => (lf.friends?.name ?? '').toLowerCase()));
		const names = hits.map((t) => FRIENDS[t.name]).filter((n) => !linked.has(n.toLowerCase()));
		// Idempotent: the friend is already linked, but the tag may still be there,
		// so keep the strip even when there's nothing new to link.
		if (names.length === 0) alreadyDone++;

		plans.push({ logId: l.id, names, consumeTagIds: hits.map((t) => t.id) });
	}

	const allNames = [...new Set(plans.flatMap((p) => p.names))].sort();
	console.log(`logs touched: ${plans.length} (${alreadyDone} already linked)`);
	console.log(`distinct people: ${allNames.length}\n`);

	for (const p of plans) {
		if (p.names.length) console.log(`  log ${String(p.logId).padStart(4)} → ${p.names.join(', ')}`);
	}
	console.log();

	if (DRY_RUN) {
		const counts = new Map();
		for (const p of plans) for (const n of p.names) counts.set(n, (counts.get(n) ?? 0) + 1);
		console.log('would link:');
		for (const [n, c] of [...counts].sort()) console.log(`  ${String(c).padStart(3)} × ${n}`);
		console.log(`\nwould strip ${plans.reduce((a, p) => a + p.consumeTagIds.length, 0)} tag links`);
		console.log(`would delete orphan tags: ${Object.keys(FRIENDS).join(', ')}`);
		console.log('\nDRY-RUN — nothing written.');
		return;
	}

	const idByKey = await resolveFriendIds(allNames);

	// --- link friends + strip consumed tags ---
	let linksAdded = 0;
	let linksRemoved = 0;
	for (const p of plans) {
		if (p.names.length) {
			const rows = p.names.map((n) => ({ log_id: p.logId, friend_id: idByKey.get(n.toLowerCase()) }));
			const { error } = await sb.from('log_friends').insert(rows);
			if (error) throw new Error(`link friends log ${p.logId}: ${error.message}`);
			linksAdded += rows.length;
		}
		const { count, error: dErr } = await sb
			.from('log_tags')
			.delete({ count: 'exact' })
			.eq('log_id', p.logId)
			.in('tag_id', p.consumeTagIds);
		if (dErr) throw new Error(`strip tags log ${p.logId}: ${dErr.message}`);
		linksRemoved += count ?? 0;
	}
	console.log(`log_friends links added: ${linksAdded}`);
	console.log(`log_tags links removed:  ${linksRemoved}`);

	// --- delete the now-orphan initial tags ---
	const { data: orphans, error: oErr } = await sb
		.from('tags')
		.select('id, name, log_tags(log_id)')
		.in('name', Object.keys(FRIENDS));
	if (oErr) throw oErr;
	const toDelete = orphans.filter((t) => (t.log_tags ?? []).length === 0);
	if (toDelete.length > 0) {
		const { error: delErr } = await sb
			.from('tags')
			.delete()
			.in('id', toDelete.map((t) => t.id));
		if (delErr) throw delErr;
	}
	console.log(`orphan tags deleted:     ${toDelete.length} (${toDelete.map((t) => t.name).join(', ')})`);
	const stuck = orphans.filter((t) => (t.log_tags ?? []).length > 0);
	if (stuck.length > 0) {
		console.log(`still linked (not deleted): ${stuck.map((t) => `${t.name}×${t.log_tags.length}`).join(', ')}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
