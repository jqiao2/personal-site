// Strava OAuth + API client — ACTIVITIES.md §4 step 3.
//
// The one thing this section's other Strava path (the bulk archive) never has
// to deal with: a credential that expires. Strava issues a short-lived access
// token (six hours) and a refresh token it ROTATES every time you spend it, so
// there is no static secret to put in an env var — the current pair lives in
// the `strava_auth` table (migration 0045) and this module is the only thing
// that reads or writes it.
//
// getAccessToken() is the whole point: every API call goes through it, it
// refreshes when the token is about to die, and it writes the rotated pair
// straight back. Callers never see a token, only the fetch helper that already
// carries a fresh one.
//
// The client id/secret ARE static and come from the environment
// (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET) — register the app once at
// https://www.strava.com/settings/api, set its "Authorization Callback Domain"
// to the site's host, and put the two values in the environment.
import { supabaseAdmin } from './supabase';

const AUTH_BASE = 'https://www.strava.com/oauth';
const API_BASE = 'https://www.strava.com/api/v3';

// read: the athlete profile (gear names). activity:read_all: private
// activities too, not just the public ones — this athlete keeps most private.
export const STRAVA_SCOPE = 'read,activity:read_all';

function clientId(): string {
	const v = import.meta.env.STRAVA_CLIENT_ID;
	if (!v) throw new Error('STRAVA_CLIENT_ID is not set');
	return v;
}
function clientSecret(): string {
	const v = import.meta.env.STRAVA_CLIENT_SECRET;
	if (!v) throw new Error('STRAVA_CLIENT_SECRET is not set');
	return v;
}

// ---------------------------------------------------------------------------
// The token row
// ---------------------------------------------------------------------------

interface AuthRow {
	athlete_id: number | null;
	access_token: string;
	refresh_token: string;
	expires_at: string; // ISO
	scope: string | null;
	last_sync_at: string | null;
}

/** Strava's token response, both grant types. `expires_at` is epoch seconds. */
interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	athlete?: { id: number };
}

async function readRow(): Promise<AuthRow | null> {
	const { data, error } = await supabaseAdmin
		.from('strava_auth')
		.select('athlete_id, access_token, refresh_token, expires_at, scope, last_sync_at')
		.eq('id', 1)
		.maybeSingle();
	if (error) throw new Error(`read strava_auth: ${error.message}`);
	return (data as AuthRow | null) ?? null;
}

async function writeTokens(t: TokenResponse, scope: string | null): Promise<void> {
	const row = {
		id: 1,
		access_token: t.access_token,
		refresh_token: t.refresh_token,
		expires_at: new Date(t.expires_at * 1000).toISOString(),
		athlete_id: t.athlete?.id ?? undefined, // keep the existing one on a refresh
		scope: scope ?? undefined,
		updated_at: new Date().toISOString(),
	};
	// Drop the "keep existing" keys so upsert doesn't null them on a refresh.
	if (row.athlete_id === undefined) delete (row as Record<string, unknown>).athlete_id;
	if (row.scope === undefined) delete (row as Record<string, unknown>).scope;
	const { error } = await supabaseAdmin.from('strava_auth').upsert(row);
	if (error) throw new Error(`write strava_auth: ${error.message}`);
}

// ---------------------------------------------------------------------------
// OAuth handshake
// ---------------------------------------------------------------------------

/** The consent URL to send the owner to. `redirectUri` must live under the
 *  callback domain registered on the Strava app. */
export function authorizeUrl(redirectUri: string): string {
	const p = new URLSearchParams({
		client_id: clientId(),
		redirect_uri: redirectUri,
		response_type: 'code',
		approval_prompt: 'auto',
		scope: STRAVA_SCOPE,
	});
	return `${AUTH_BASE}/authorize?${p}`;
}

async function tokenExchange(body: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(`${AUTH_BASE}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...body }),
	});
	if (!res.ok) throw new Error(`strava token ${res.status}: ${await res.text()}`);
	return (await res.json()) as TokenResponse;
}

/** Exchange the `code` from the callback for the first token pair, and store
 *  it. Sets the sync watermark to now: this connection pulls rides made AFTER
 *  it was authorised, not the whole history (that's the archive importer). */
export async function exchangeCode(code: string): Promise<void> {
	const t = await tokenExchange({ code, grant_type: 'authorization_code' });
	await writeTokens(t, STRAVA_SCOPE);
	await supabaseAdmin.from('strava_auth').update({ last_sync_at: new Date().toISOString() }).eq('id', 1);
}

/**
 * A valid access token, refreshing first if the stored one is within a minute
 * of expiry. Writes the rotated pair back — Strava rotates the refresh token
 * on every spend, so the old one is dead the moment this returns.
 *
 * ponytail: no lock around the read-refresh-write. Two concurrent refreshes
 * would race and one rotated token would be lost, forcing a reconnect. For a
 * single-user site on a daily cron plus the odd manual sync that never
 * overlaps in practice; add a row lock only if it ever actually bites.
 */
export async function getAccessToken(): Promise<string> {
	const row = await readRow();
	if (!row) throw new Error('Strava is not connected — visit /activities/import to connect.');
	if (Date.parse(row.expires_at) - Date.now() > 60_000) return row.access_token;

	const t = await tokenExchange({ refresh_token: row.refresh_token, grant_type: 'refresh_token' });
	await writeTokens(t, null);
	return t.access_token;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * GET an API path with a fresh bearer token. One retry after a forced refresh
 * on a 401, in case the token died between getAccessToken's check and the call.
 * Throws with the status on anything else, including 429 (rate limit) — the
 * sync loop catches that and stops rather than hammering.
 */
export async function stravaGet(path: string, params?: Record<string, string | number>): Promise<unknown> {
	const url = new URL(`${API_BASE}${path}`);
	for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));

	const call = async (token: string) =>
		fetch(url, { headers: { authorization: `Bearer ${token}` } });

	let res = await call(await getAccessToken());
	if (res.status === 401) {
		// Force a refresh by expiring the row, then retry once.
		await supabaseAdmin.from('strava_auth').update({ expires_at: new Date(0).toISOString() }).eq('id', 1);
		res = await call(await getAccessToken());
	}
	if (!res.ok) throw new Error(`strava GET ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

// ---------------------------------------------------------------------------
// Connection status — for the /activities/import page. Never returns a token.
// ---------------------------------------------------------------------------

export interface StravaConnection {
	athleteId: number | null;
	scope: string | null;
	expiresAt: string;
	lastSyncAt: string | null;
}

export async function getConnection(): Promise<StravaConnection | null> {
	const row = await readRow();
	if (!row) return null;
	return {
		athleteId: row.athlete_id,
		scope: row.scope,
		expiresAt: row.expires_at,
		lastSyncAt: row.last_sync_at,
	};
}
