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

// Which categories this account uses. Both lists are queried one category
// code at a time, and user-scores is the cheap way to learn the full set —
// one row per ranked place, each carrying its category.
console.error('discovering categories…');
const scores = await call('GET', `${API}/api/user-scores/${uuid}/`, access);
const scoreList = Array.isArray(scores) ? scores : (scores?.results ?? []);
const categories = [...new Set(scoreList.map((s) => s.category).filter(Boolean))];
console.error(`  ${scoreList.length} ranked across ${categories.length} categories: ${categories.join(', ')}`);

/** Every row from a per-category endpoint whose response is { "<name>": [rows] } or [rows]. */
async function perCategory(pathFor, onRow) {
	const out = [];
	for (const cat of categories) {
		await sleep(SPACING_MS);
		try {
			const resp = await call('GET', pathFor(cat), access);
			const rows = Array.isArray(resp) ? resp : Object.values(resp ?? {}).flat();
			for (const r of rows) {
				const row = onRow(r, cat);
				if (row) out.push(row);
			}
			if (raw) writeFileSync(`tmp/beli-${pathFor(cat).match(/\/api\/([^/?]+)/)[1]}-${cat}.json`, JSON.stringify(resp, null, 2));
		} catch (err) {
			console.error(`  ${cat}: ${err.message}`);
		}
	}
	return out;
}

// --- ranked ("been") ------------------------------------------------------
// get-ranking carries the business inline AND the visit dates and Beli's
// computed score, so it needs no hydration and gives a real visited-on date.
console.error('fetching ranked list (get-ranking)…');
const been = (
	await perCategory(
		(cat) => `${API}/api/get-ranking/?user=${uuid}&category=${cat}`,
		(r, cat) =>
			r.business && {
				...pick(r.business),
				category: cat,
				score: r.score ?? r.value ?? null,
				visit_dates: r.visit_dates ?? [],
				ranked_on: r.created_dt ?? null,
			},
	)
).filter((r) => r.name);
console.error(`  ${been.length} been`);

// --- bookmarked ("want to try") ------------------------------------------
console.error('fetching bookmarks (get-bookmark)…');
const want = (
	await perCategory(
		(cat) => `${API}/api/get-bookmark/?user=${uuid}&category=${cat}`,
		(r, cat) => r.business && { ...pick(r.business), category: cat, bookmarked_on: r.start_dt ?? null },
	)
).filter((r) => r.name);
console.error(`  ${want.length} bookmarked`);

writeFileSync('tmp/beli.json', JSON.stringify({ been, want }, null, 2));
console.error(`\nwrote tmp/beli.json — ${been.length} been, ${want.length} want to try`);
if (been[0]) console.error(`  e.g. ${been[0].name} (${been[0].city}) score ${been[0].score} on ${been[0].visit_dates?.[0] ?? '—'}`);
