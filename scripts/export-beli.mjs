// Pull your own Beli lists out as JSON, to backfill the restaurant log.
//
// Beli has no export button and no official API. It does have a backend the
// app talks to, and your own account can read your own lists from it. This
// signs in as you, reads your ranked ("been") list and your bookmarked
// ("want to try") list, hydrates each place to a full business record, and
// writes them to tmp/beli.json. It is your data, fetched with your
// credentials — but the endpoints are reverse-engineered and unofficial
// (community spec: github.com/ProjectBarks/beli-api), so this may break the
// day Beli changes something.
//
// How the two lists are read, both verified live against this account:
//   been  GET  /api/user-scores/{uuid}/            -> [{business_id, value, category}]
//   want  GET  /api/get-bookmark/?user={uuid}&category={CODE}  -> { <name>: [rows] }
// Neither carries the place itself, only its integer id and your score, so the
// ids are hydrated in batches through /api/filter-list/ ({ids, load_businesses}),
// which is the same call the app uses to turn an id into a business.
//
// Usage (credentials in .env, never on the command line):
//   node --env-file=.env scripts/export-beli.mjs            # -> tmp/beli.json
//   node --env-file=.env scripts/export-beli.mjs --raw      # also dump raw responses
import { writeFileSync, mkdirSync } from 'node:fs';

const ONBOARD = 'https://backoffice-service-onboarding-t57o3dxfca-nn.a.run.app';
const API = 'https://backoffice-service-t57o3dxfca-nn.a.run.app';
// The backend answers 403 to anything that does not look like the web app —
// it wants a browser User-Agent and an Origin. These satisfy that.
const ORIGIN = 'https://app.beliapp.com';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SPACING_MS = 400; // the API throttles bursts; space calls out
const HYDRATE_CHUNK = 50;

const raw = process.argv.includes('--raw');
const email = process.env.BELI_EMAIL;
const password = process.env.BELI_PASSWORD;
if (!email || !password) {
	console.error('Set BELI_EMAIL and BELI_PASSWORD in .env, then run with --env-file=.env.');
	process.exit(1);
}
mkdirSync('tmp', { recursive: true });

const headers = (token) => ({
	'content-type': 'application/json',
	accept: 'application/json',
	origin: ORIGIN,
	'user-agent': UA,
	...(token ? { authorization: `Bearer ${token}` } : {}),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch that rides out this network's occasional connect timeouts. */
async function call(method, url, token, body, tries = 4) {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url, {
				method,
				headers: headers(token),
				body: body ? JSON.stringify(body) : undefined,
			});
			const text = await res.text();
			let json = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				/* leave null */
			}
			if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 160)}`);
			return json;
		} catch (err) {
			if (attempt >= tries - 1) throw err;
			await sleep(800 * 2 ** attempt);
		}
	}
}

/** The fields worth keeping off a hydrated business — the shape `restaurants` wants. */
function pick(b) {
	if (!b) return null;
	return {
		beli_id: b.id,
		google_place_id: b.place_id ?? null,
		name: b.name,
		city: b.city ?? null,
		neighborhood: b.neighborhood ?? b.borough ?? null,
		lat: b.lat ?? null,
		lng: b.lng ?? null,
		cuisines: b.cuisines ?? [],
		price: b.price ?? null,
		country: b.country ?? null,
		website: b.website ?? null,
		phone: b.phone_number ?? null,
	};
}

// ---------------------------------------------------------------------------

console.error('logging in…');
const { access } = await call('POST', `${ONBOARD}/api/token/`, null, { email, password });
if (!access) throw new Error('no access token came back — check the credentials');

const me = await call('GET', `${ONBOARD}/api/user/logged-in/`, access);
if (raw) writeFileSync('tmp/beli-me.json', JSON.stringify(me, null, 2));
const wrapped = me?.results ?? me ?? {};
const profile = Array.isArray(wrapped) ? (wrapped[0] ?? {}) : wrapped;
const uuid = profile.id ?? profile.uuid ?? profile.user_id ?? profile.user?.id;
if (!uuid) throw new Error(`could not find your user id; profile keys were ${Object.keys(profile)}`);
console.error(`  you are ${profile.username ?? uuid}`);

// --- ranked ("been") ------------------------------------------------------
console.error('fetching ranked list (user-scores)…');
const scores = await call('GET', `${API}/api/user-scores/${uuid}/`, access);
const scoreList = Array.isArray(scores) ? scores : (scores?.results ?? []);
console.error(`  ${scoreList.length} ranked`);
// The categories this account actually uses — what to ask the bookmark
// endpoint about, since it is queried one category code at a time.
const categories = [...new Set(scoreList.map((s) => s.category).filter(Boolean))];

// --- bookmarked ("want to try") ------------------------------------------
console.error(`fetching bookmarks across ${categories.length} categories…`);
const bookmarkRows = [];
for (const cat of categories) {
	await sleep(SPACING_MS);
	try {
		const resp = await call('GET', `${API}/api/get-bookmark/?user=${uuid}&category=${cat}`, access);
		// Response is { "<display name>": [ rows ] }; each row already carries the
		// full business inline (r.business), so unlike the ranked list there is
		// nothing to hydrate.
		const rows = Object.values(resp ?? {}).flat();
		for (const r of rows) {
			if (r.business) bookmarkRows.push({ business: r.business, category: cat });
		}
		if (raw) writeFileSync(`tmp/beli-bookmark-${cat}.json`, JSON.stringify(resp, null, 2));
	} catch (err) {
		console.error(`  ${cat}: ${err.message}`);
	}
}
console.error(`  ${bookmarkRows.length} bookmarked`);

// --- hydrate the ranked ids to businesses (bookmarks came hydrated) -------
const allIds = [...new Set(scoreList.map((s) => s.business_id))].filter((id) => id != null);
console.error(`hydrating ${allIds.length} businesses…`);
const byId = new Map();
async function hydrate(ids) {
	const page = await call('POST', `${API}/api/filter-list/`, access, {
		user: String(uuid),
		ids,
		load_businesses: true,
	});
	for (const [id, b] of Object.entries(page?.business_hash ?? {})) byId.set(Number(id), b);
	for (const b of page?.businesses ?? []) if (b?.id != null) byId.set(Number(b.id), b);
}
let skipped = 0;
for (let i = 0; i < allIds.length; i += HYDRATE_CHUNK) {
	const chunk = allIds.slice(i, i + HYDRATE_CHUNK);
	try {
		await hydrate(chunk);
	} catch {
		// One id in the batch server-errors the whole call (a deleted place, say).
		// Drop to single ids so the rest of the chunk still lands, and skip the bad.
		for (const id of chunk) {
			try {
				await hydrate([id]);
			} catch {
				skipped++;
			}
			await sleep(SPACING_MS);
		}
	}
	process.stderr.write(`  ${Math.min(i + HYDRATE_CHUNK, allIds.length)}/${allIds.length}\r`);
	await sleep(SPACING_MS);
}
if (skipped) console.error(`\n  ${skipped} id(s) could not be hydrated (likely removed from Beli), skipped`);

const been = scoreList
	.map((s) => ({ ...pick(byId.get(s.business_id)), score: s.value, category: s.category }))
	.filter((r) => r.name);
const want = bookmarkRows
	.map((b) => ({ ...pick(b.business), category: b.category }))
	.filter((r) => r.name);

writeFileSync('tmp/beli.json', JSON.stringify({ been, want }, null, 2));
console.error(`\nwrote tmp/beli.json — ${been.length} been, ${want.length} want to try`);
if (been[0]) console.error(`  e.g. ${been[0].name} (${been[0].city}) score ${been[0].score}`);
