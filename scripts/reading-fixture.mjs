// Emit a realistic KOReader sync payload — a few hundred sequential pages with
// plausible dwell times, spread across several evenings — for exercising
// POST /api/books/sync without a Kindle in hand.
//
// KOReader logs one row per page turn, so an evening's reading is dozens of
// rows, not one; that shape is what the idempotency constraint has to survive,
// and it's what this reproduces.
//
// Deterministic: the RNG is seeded per calendar day, so the same day always
// produces byte-identical rows across runs. That's what makes the resend and
// partial-overlap tests meaningful — two invocations covering overlapping dates
// agree exactly on the rows they share.
//
// Usage:
//   node scripts/reading-fixture.mjs [options] > payload.json
//   node --env-file=.env scripts/reading-fixture.mjs --post http://localhost:4321
//
// Options:
//   --from YYYY-MM-DD   First evening (default: 5 days ago, local)
//   --days N            Number of consecutive evenings      (default 5)
//   --pages N           Pages per evening                   (default 40)
//   --start-page N      Page number on the first evening    (default 1)
//   --total-pages N     The book's page count               (default 320)
//   --title / --author / --md5 / --device
//   --seed N            RNG seed                            (default 20260802)
//   --post BASE_URL     POST it to BASE_URL/api/books/sync using
//                       READING_SYNC_TOKEN from the environment
//   --pretty            Indent the JSON

const TZ = 'America/New_York';

const args = parseArgs(process.argv.slice(2));
const opts = {
	from: args.from ?? isoDate(Date.now() - 5 * 86400_000),
	days: int(args.days, 5),
	pages: int(args.pages, 40),
	startPage: int(args['start-page'], 1),
	totalPages: int(args['total-pages'], 320),
	title: args.title ?? 'Piranesi',
	author: args.author ?? 'Susanna Clarke',
	md5: (args.md5 ?? 'f17a4e0d3b2a1c9e8f7a6b5c4d3e2f10').toLowerCase(),
	device: args.device ?? 'kindle-pw5',
	seed: int(args.seed, 20260802),
};

const payload = buildPayload(opts);

if (args.post) {
	await post(String(args.post), payload);
} else {
	process.stdout.write(JSON.stringify(payload, null, args.pretty ? 2 : 0) + '\n');
}

// ---------------------------------------------------------------------------

function buildPayload(o) {
	const sessions = [];
	let page = o.startPage;

	for (let d = 0; d < o.days; d++) {
		const day = addDays(o.from, d);
		// Seeded from the date itself, not the loop index, so a given evening is
		// reproducible no matter which run it falls in.
		const rand = mulberry32(o.seed + dayNumber(day));

		// Settle in somewhere between 20:45 and 22:15 local.
		let t = zonedEpochSeconds(day, 20, 45) + Math.floor(rand() * 90 * 60);

		for (let i = 0; i < o.pages; i++) {
			// 20–60s a page, with the occasional long pause — a reread, a look out
			// the window. The tail matters: it's what makes seconds_read realistic.
			const duration = rand() < 0.06
				? 60 + Math.floor(rand() * 240)
				: 20 + Math.floor(rand() * 41);
			sessions.push({
				book_md5: o.md5,
				page,
				start_time: t,
				duration,
				total_pages: o.totalPages,
				device: o.device,
			});
			t += duration;
			page += 1;
		}
	}

	return {
		device: o.device,
		books: [
			{
				md5: o.md5,
				title: o.title,
				authors: o.author,
				series: null,
				language: 'en',
				total_pages: o.totalPages,
			},
		],
		sessions,
	};
}

async function post(baseUrl, body) {
	const token = process.env.READING_SYNC_TOKEN;
	if (!token) {
		console.error('READING_SYNC_TOKEN is not set (try: node --env-file=.env …)');
		process.exit(1);
	}
	const url = new URL('/api/books/sync', baseUrl).toString();
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	console.log(`${res.status} ${url}`);
	console.log(text);
	if (!res.ok) process.exit(1);
}

// --- time -------------------------------------------------------------------

/**
 * Epoch seconds for `HH:MM` local time on `YYYY-MM-DD` in TZ.
 *
 * Done by guess-and-correct rather than arithmetic on a fixed -05:00, because
 * the offset changes twice a year and a heatmap that shifts a day every March
 * is worse than no heatmap.
 */
function zonedEpochSeconds(date, hour, minute) {
	const [y, m, d] = date.split('-').map(Number);
	const wall = Date.UTC(y, m - 1, d, hour, minute);
	let ts = wall;
	for (let i = 0; i < 2; i++) ts = wall - tzOffsetMs(ts);
	return Math.floor(ts / 1000);
}

function tzOffsetMs(ts) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', {
			timeZone: TZ,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		})
			.formatToParts(ts)
			.map((p) => [p.type, p.value]),
	);
	const asUtc = Date.UTC(
		+parts.year,
		+parts.month - 1,
		+parts.day,
		+parts.hour % 24,
		+parts.minute,
		+parts.second,
	);
	return asUtc - ts;
}

function isoDate(ms) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(ms);
	return parts;
}

function addDays(date, n) {
	const [y, m, d] = date.split('-').map(Number);
	const t = new Date(Date.UTC(y, m - 1, d + n));
	return t.toISOString().slice(0, 10);
}

/** Days since the epoch — a stable per-date RNG seed. */
function dayNumber(date) {
	const [y, m, d] = date.split('-').map(Number);
	return Math.floor(Date.UTC(y, m - 1, d) / 86400_000);
}

// --- misc -------------------------------------------------------------------

function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function int(v, fallback) {
	const n = Number.parseInt(String(v), 10);
	return Number.isFinite(n) ? n : fallback;
}
