// One-off correction: "bike" was backfilled as a medium, but it's a viewing
// context (watched while biking) — the real medium (computer vs TV) is unknown.
// Revert: re-tag those logs "bike" and null their medium. Idempotent.
//   node --env-file=.env scripts/fix-bike-medium.mjs
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const { data: logs, error } = await sb.from('logs').select('id').eq('medium', 'bike');
if (error) throw error;
console.log(`logs with medium='bike': ${logs.length}`);
if (logs.length === 0) {
	console.log('nothing to do.');
	process.exit(0);
}

// Ensure the "bike" tag exists.
const { data: tag, error: tErr } = await sb
	.from('tags')
	.upsert({ name: 'bike' }, { onConflict: 'name' })
	.select('id')
	.single();
if (tErr) throw tErr;

// Re-link the tag (ignore duplicates), then clear medium.
const links = logs.map((l) => ({ log_id: l.id, tag_id: tag.id }));
const { error: lErr } = await sb
	.from('log_tags')
	.upsert(links, { onConflict: 'log_id,tag_id', ignoreDuplicates: true });
if (lErr) throw lErr;

const { error: uErr } = await sb.from('logs').update({ medium: null }).eq('medium', 'bike');
if (uErr) throw uErr;

console.log(`✓ re-tagged ${logs.length} logs "bike" and cleared medium.`);
