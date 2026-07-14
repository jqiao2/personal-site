// Set theater viewings with no recorded format to "Digital" (a standard digital
// projection is the sensible default for a theater screening without a special
// format tag). Idempotent — only touches theater logs whose format_id is null.
//   node --env-file=.env scripts/fill-digital-format.mjs
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false },
});

// Ensure the "Digital" format row exists.
const { data: fmt, error: fErr } = await sb
	.from('formats')
	.upsert({ name: 'Digital' }, { onConflict: 'name' })
	.select('id')
	.single();
if (fErr) throw fErr;

const { data, error } = await sb
	.from('logs')
	.update({ format_id: fmt.id })
	.eq('medium', 'theater')
	.is('format_id', null)
	.select('id');
if (error) throw error;

console.log(`✓ set ${data.length} theater logs to Digital.`);
