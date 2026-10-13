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
