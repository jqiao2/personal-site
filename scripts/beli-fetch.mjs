// Pull a Beli account's lists down to a file, verbatim.
//
// Beli has no export. There is no "download my data" button, no public profile
// page to read, and the community scraper that used to work talked to a host
// (beli.cleverapps.io) that has since gone away. What there IS, and what this
// uses, is the web app at https://app.beliapp.com — an Ionic build of the same
// product that talks to a REST API, which means the account can be read from a
// browser session rather than off a phone with a proxy in front of it.
//
// The two endpoints are the same pair the old scraper used, rehosted:
//
//   GET /api/user/web-map-user/?&username=<username>   → the user, for its id
//   GET /api/rank-list/<user id>/                      → the list itself
//
// Both require an Authorization header. THIS SCRIPT DOES NOT LOG IN and does
// not want a password: it takes the header value off a browser session you have
// already opened, which keeps the credential out of this repo, out of the shell
// history if you use the env var, and means it works whatever scheme Beli
// happens to be issuing this month.
//
// Getting the header, once:
//
//   1. Open https://app.beliapp.com and sign in.
//   2. Open devtools → Network, and click through to your own list so a request
//      to backoffice-service-…run.app/api/ goes out.
//   3. Click that request → Headers → Request Headers → copy the whole
//      `authorization` value, including the leading word (`Bearer …`/`Token …`).
//
// Usage:
//   export BELI_AUTH='Bearer eyJ…'
//   node scripts/beli-fetch.mjs jqiao                    # → beli-jqiao.json
//   node scripts/beli-fetch.mjs jqiao -o somewhere.json
//
// WHY THIS IS A SEPARATE SCRIPT from the import. The same split as
// `credits:fetch` and `credits:load`: fetching needs a credential that expires
// in an hour and a network round trip, mapping needs neither and will be run
// again every time the mapping is wrong. Keeping the raw JSON on disk means the
// second half can be re-run and corrected all afternoon without going back to
// Beli, and means that if their field names have moved since this was written,
// the evidence is sitting in a file rather than gone.
//
// It writes the response bodies UNCHANGED, then prints the field names and the
// distinct `status` values it saw, because those are what the importer maps and
// they are the thing most likely to have drifted.
import { writeFileSync } from 'node:fs';

const API = 'https://backoffice-service-t57o3dxfca-nn.a.run.app/api';

const [, , username, ...flags] = process.argv;
const auth = flagValue('--token') ?? process.env.BELI_AUTH ?? '';
const out = flagValue('-o') ?? flagValue('--out') ?? `beli-${username}.json`;

if (!username) {
	console.error('usage: node scripts/beli-fetch.mjs <username> [-o out.json] [--token "Bearer …"]');
	process.exit(1);
}
if (!auth) {
	console.error(`No credential. Set BELI_AUTH to the authorization header from an
open https://app.beliapp.com session, or pass --token "Bearer …".
See the note at the top of this file for where to find it.`);
	process.exit(1);
}

function flagValue(name) {
	const i = flags.indexOf(name);
	return i >= 0 ? flags[i + 1] : undefined;
}

/**
 * One GET against the API, with the browser's own headers.
 *
 * The origin and referer are sent because the API is a Cloud Run service fronting
 * a browser app: a request that does not look like it came from the web app is
 * the one most likely to be refused, and this request genuinely did come from
 * that app's session.
 */
async function api(path) {
	const res = await fetch(API + path, {
		headers: {
			authorization: auth,
			accept: 'application/json',
			origin: 'https://app.beliapp.com',
			referer: 'https://app.beliapp.com/',
		},
	});
	const body = await res.text();
	if (!res.ok) {
		// 401 here is almost always the token having expired rather than anything
		// structural — they are short-lived, and the fix is another copy-paste.
		const hint =
			res.status === 401 || res.status === 403
				? '\nThe credential was rejected. These expire quickly — reload app.beliapp.com and copy a fresh one.'
				: '';
		throw new Error(`GET ${path} → HTTP ${res.status}${hint}\n${body.slice(0, 400)}`);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`GET ${path} did not return JSON:\n${body.slice(0, 400)}`);
	}
}

/** Whatever shape the endpoint wraps its rows in. DRF paginates, but not always. */
function rowsOf(payload) {
	if (Array.isArray(payload)) return payload;
	for (const key of ['results', 'data', 'items']) {
		if (Array.isArray(payload?.[key])) return payload[key];
	}
	return [];
}

// The API's own failures are expected rather than exceptional — an expired
// token is the normal way this script ends — so they are reported as a sentence
// instead of a stack trace nobody needs to read.
async function tryApi(path) {
	try {
		return await api(path);
	} catch (err) {
		console.error(`\n${err.message}`);
		process.exit(1);
	}
}

console.log(`looking up ${username}…`);
const found = rowsOf(await tryApi(`/user/web-map-user/?&username=${encodeURIComponent(username)}`));
const user = found[0];
if (!user) {
	console.error(`no user called "${username}" came back.`);
	process.exit(1);
}
console.log(`  ${user.username ?? username} — id ${user.id}`);

console.log('fetching the list…');
const list = await tryApi(`/rank-list/${user.id}/`);
const rows = rowsOf(list);

writeFileSync(out, JSON.stringify({ user, rank_list: list }, null, '\t'));

console.log(`\n${rows.length} row${rows.length === 1 ? '' : 's'} written to ${out}`);

if (rows.length === 0) {
	console.log('\nNothing came back. If the account definitely has places on it, the');
	console.log('response shape has probably changed — the file has the raw body in it.');
	process.exit(0);
}

// The two things the importer keys off, reported so a drift in either is
// visible here rather than as a wrong row three steps later.
const fields = new Set();
for (const row of rows) for (const k of Object.keys(row)) fields.add(k);
console.log(`\nfields present:\n  ${[...fields].sort().join(', ')}`);

const statuses = new Map();
for (const row of rows) {
	const s = String(row.status ?? row.business__status ?? '(none)');
	statuses.set(s, (statuses.get(s) ?? 0) + 1);
}
console.log('\nstatus values:');
for (const [s, n] of [...statuses].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${s}`);

console.log(`\nnext: node --env-file=.env scripts/import-beli.mjs ${out}`);
