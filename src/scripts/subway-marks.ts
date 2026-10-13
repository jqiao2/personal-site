// Where /subway's marks live. The owner's log is saved to the site
// (/api/subway/log, table subway_marks); a visitor starts blank on every visit
// and their clicks last only as long as the page.
//
// The page is static, so it tells the owner apart by the readable `owner=1`
// hint cookie (see SiteHeader.astro). That only decides whether to ask: the API
// checks the real session, so a stranger with the hint gets a 401, not a log.

/** Marked stations / segments, as id → 1 sets. */
export type Marks = { st: Record<string, 1>; seg: Record<string, 1> };

const API = '/api/subway/log';

// The log used to live in localStorage under this key. The owner's first visit
// after the move uploads it if the site has nothing yet, then drops it.
const OLD_KEY = 'mta-subway-log-v2';

// Segment ids the data no longer has -> the segment that now covers that ride.
// The M's phantom B'way-Lafayette -> Marcy Av link is Essex St -> Marcy Av; the R's
// phantom Canal St -> DeKalb Av is Jay St-MetroTech -> DeKalb Av.
const RETIRED = { 'M|92633|93927': 'M|92633|92642', 'R|91885|92660': 'R|91876|91885' } satisfies Record<string, string>;

export const isOwner = () => document.cookie.split('; ').includes('owner=1');

const toSets = (st: string[], seg: string[]): Marks => ({
	st: Object.fromEntries(st.map((id) => [id, 1 as const])),
	seg: Object.fromEntries(seg.map((id) => [id, 1 as const])),
});

type Payload = { kind: 'station' | 'segment'; ref: string; on: boolean } | { st: string[]; seg: string[] };

async function send(method: 'GET' | 'POST' | 'PUT', body?: Payload) {
	const res = await fetch(API, {
		method,
		headers: body ? { 'content-type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined,
	});

	if (!res.ok) throw new Error(`${method} ${API}: ${res.status}`);

	return res;
}

export async function loadMarks(): Promise<Marks> {
	if (!isOwner()) return { st: {}, seg: {} };
	const saved: { st: string[]; seg: string[] } = await (await send('GET')).json();
	let old: Marks | null = null;

	try {
		old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null');
	} catch {}

	if (old?.st && old.seg && !saved.st.length && !saved.seg.length) {
		const upload = { st: Object.keys(old.st), seg: Object.keys(old.seg) };
		await send('PUT', upload);
		saved.st = upload.st;
		saved.seg = upload.seg;
	}

	try {
		localStorage.removeItem(OLD_KEY);
	} catch {}

	// a segment the generator dropped keeps its ride on the one that replaced it
	for (const [old, now] of Object.entries(RETIRED)) {
		if (!saved.seg.includes(old)) continue;
		await send('POST', { kind: 'segment', ref: now, on: true });
		await send('POST', { kind: 'segment', ref: old, on: false });
		saved.seg = [...saved.seg.filter((id) => id !== old && id !== now), now];
	}

	return toSets(saved.st, saved.seg);
}

/** Save one mark (owner only; a visitor's clicks aren't kept). */
export async function saveMark(kind: 'station' | 'segment', ref: string, on: boolean) {
	if (isOwner()) await send('POST', { kind, ref, on });
}

/** Replace the whole saved log, after an import (owner only). */
export async function saveAll(marks: Marks) {
	if (isOwner()) await send('PUT', { st: Object.keys(marks.st), seg: Object.keys(marks.seg) });
}
