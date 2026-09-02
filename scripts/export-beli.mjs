// Pull your own Beli lists out as JSON, to backfill the restaurant log.
//
// Beli has no export button and no official API. It does have a backend the
// app talks to, and your own account can read your own lists from it. This
// signs in as you, reads your ranked ("been") list and your bookmarked
// ("want to try") list, and writes them to a file. Nothing here is Beli's to
// give or withhold — it is your data, fetched with your credentials — but it
// is reverse-engineered and unofficial, so it may break the day Beli changes
// something. Endpoints and shapes come from the community spec at
// github.com/ProjectBarks/beli-api.
//
// Usage:
//   BELI_EMAIL / BELI_PASSWORD in .env (NOT on the command line), then:
//   node --env-file=.env scripts/export-beli.mjs              # both lists → tmp/beli.json
//   node --env-file=.env scripts/export-beli.mjs been         # just the ranked list
//   node --env-file=.env scripts/export-beli.mjs --raw        # also dump the first
//                                                             # response, to read the shape
//
// The output is raw on purpose: every field Beli returns is kept, so the
// mapping into `restaurants` (which carries a rank and a score Beli has and
// this log does not yet) can be decided once by looking at real data rather
// than guessed at here. See the summary it prints for what came back.
import { writeFileSync, mkdirSync } from 'node:fs';

// The four hosts the app split its backend across; login and profile live on
// ONBOARD, the list query on API. Taken from the community spec's `servers`.
const ONBOARD = 'https://backoffice-service-onboarding-t57o3dxfca-nn.a.run.app';
const API = 'https://backoffice-service-t57o3dxfca-nn.a.run.app';
// The backend answers 403 to anything that does not look like the web app:
// it wants a browser User-Agent and an Origin. These satisfy that.
const ORIGIN = 'https://app.beliapp.com';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
// The API throttles bursts; the spec spaces calls ~350 ms apart.
const SPACING_MS = 400;

const args = process.argv.slice(2);
const raw = args.includes('--raw');
// Which lists to pull. Beli's own field names are the risk here — if a list
// comes back empty, try the other spelling and tell me which worked.
const only = args.find((a) => !a.startsWith('--'));
const lists = only
	? [{ field: only, label: only }]
	: [
			{ field: 'been', label: 'ranked (been)' },
			{ field: 'want_to_try', label: 'bookmarked (want to try)' },
		];

const email = process.env.BELI_EMAIL;
const password = process.env.BELI_PASSWORD;
if (!email || !password) {
	console.error('Set BELI_EMAIL and BELI_PASSWORD in .env, then run with --env-file=.env.');
	process.exit(1);
}

const headers = (token) => ({
	'content-type': 'application/json',
	accept: 'application/json',
	origin: ORIGIN,
	'user-agent': UA,
	...(token ? { authorization: `Bearer ${token}` } : {}),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, token, body) {
	const res = await fetch(url, {
		method,
		headers: headers(token),
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	if (!res.ok) {
		throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 200)}`);
	}
	return json;
}

// ---------------------------------------------------------------------------

console.error('logging in…');
const { access } = await call('POST', `${ONBOARD}/api/token/`, null, { email, password });
if (!access) throw new Error('no access token came back — check the credentials');

const me = await call('GET', `${ONBOARD}/api/user/logged-in/`, access);
// The profile is wrapped in { results: {...} }; the uuid is the id on it. The
// exact key is not certain across versions, so take the first that looks right.
const profile = me?.results ?? me ?? {};
const uuid = profile.id ?? profile.uuid ?? profile.user_id ?? profile.user?.id;
if (!uuid) {
	console.error('could not find your user id in the profile. Its keys were:');
	console.error(' ', Object.keys(profile).join(', '));
	console.error('Re-run with --raw and send me tmp/beli-me.json.');
	writeFileSync('tmp/beli-me.json', JSON.stringify(me, null, 2));
	process.exit(1);
}
console.error(`  you are ${profile.username ?? profile.name ?? uuid}`);

/** One list, following pagination until it runs out. */
async function fetchList(field) {
	const out = [];
	let first = null;
	// Beli paginates DRF-style: the response carries a `next` URL, or nothing.
	// The first page is a POST; `next`, when present, is a GET on a full URL.
	let page = await call('POST', `${API}/api/filter-list/`, access, {
		user: String(uuid),
		list_field: field,
		load_businesses: true,
	});
	for (;;) {
		if (!first) first = page;
		const rows = Array.isArray(page) ? page : (page?.results ?? []);
		out.push(...rows);
		const next = page?.next;
		if (!next || rows.length === 0) break;
		await sleep(SPACING_MS);
		page = await call('GET', next, access);
	}
	return { rows: out, first };
}

mkdirSync('tmp', { recursive: true });
const result = {};
for (const { field, label } of lists) {
	console.error(`fetching ${label}…`);
	try {
		const { rows, first } = await fetchList(field);
		result[field] = rows;
		console.error(`  ${rows.length} places`);
		if (raw) writeFileSync(`tmp/beli-${field}-first.json`, JSON.stringify(first, null, 2));
		// A tiny peek so a wrong field name is obvious immediately.
		const sample = rows[0];
		if (sample) {
			const biz = sample.business ?? sample;
			console.error(`  e.g. ${biz.name ?? biz.business_name ?? JSON.stringify(sample).slice(0, 80)}`);
		}
	} catch (err) {
		console.error(`  failed: ${err.message}`);
		result[field] = { error: err.message };
	}
	await sleep(SPACING_MS);
}

writeFileSync('tmp/beli.json', JSON.stringify(result, null, 2));
console.error('\nwrote tmp/beli.json');
console.error('If a list is empty or the names look wrong, re-run with --raw and send me the tmp/beli-*-first.json — the field name or response shape needs one tweak.');
