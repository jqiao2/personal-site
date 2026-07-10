// Two server-side Supabase clients:
//   - supabaseAdmin: service-role key, BYPASSES row-level security. Use for
//     writes (creating logs, upserting the movie cache, editing the watchlist)
//     only after the owner's session is verified. Never import into client code.
//   - supabasePublic: anon key, subject to RLS (read-only per our policies). Use
//     for reads in server routes; also safe to use from prerendered pages.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.SUPABASE_URL;

function required(name: string, value: string | undefined): string {
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export const supabaseAdmin = createClient(
	required('SUPABASE_URL', url),
	required('SUPABASE_SERVICE_ROLE_KEY', import.meta.env.SUPABASE_SERVICE_ROLE_KEY),
	{ auth: { persistSession: false, autoRefreshToken: false } },
);

export const supabasePublic = createClient(
	required('SUPABASE_URL', url),
	required('SUPABASE_ANON_KEY', import.meta.env.SUPABASE_ANON_KEY),
	{ auth: { persistSession: false, autoRefreshToken: false } },
);
