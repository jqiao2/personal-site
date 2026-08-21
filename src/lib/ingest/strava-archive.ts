// The Strava bulk export — ACTIVITIES.md §4's step 1, and the provider that
// makes every page in this section real instead of a mock.
//
// WHY THE ARCHIVE AND NOT THE API. No OAuth app, no approval queue, no rate
// limit, and it carries the entire history rather than the recent slice. It is
// also the owner's own data export rather than an API response, which is why
// §4 records it as `strava_archive` and not `strava_api`: the API Agreement's
// attribution and comparison rules attach to the API path, and keeping the two
// provider values distinct is what keeps that claim checkable later.
//
// The archive is a directory: `activities.csv` (one row per activity, the
// summary Strava holds) plus `activities/<id>.<ext>` per activity, which is
// whatever file was originally uploaded — FIT, GPX or TCX, usually gzipped.
// The CSV is the spine: it covers rows that have no file at all (manual
// entries), and it carries the two things no device file knows — the title the
// athlete typed and the description they wrote.

import type { CanonicalActivity } from './canonical';
import { sportFromStrava } from './canonical';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * A CSV reader, because the file needs one and nothing else in the repo does.
 *
 * ponytail: 25 lines instead of a parser dependency. It handles the only
 * things this file actually contains — quoted fields, doubled quotes inside
 * them, embedded newlines and CRLF. If a second CSV source ever appears, that
 * is the moment to reach for a real parser rather than to grow this.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (c !== '\r') field += c;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/**
 * The header repeats four names — `Elapsed Time`, `Distance`, `Max Heart Rate`
 * and `Relative Effort` all appear twice. The first of each pair is the value
 * Strava shows in the UI (rounded, and `Distance` in kilometres); the second
 * is the precise one off the activity itself (metres, seconds). So columns are
 * addressed by INDEX, and a lookup by name takes the LAST index of that name,
 * which is the precise copy in every one of the four cases.
 */
export interface CsvIndex {
	header: string[];
	/** Last index bearing this name — the precise copy, see above. */
	col(name: string): number;
	/** First index bearing this name — the display copy. Only wanted for the
	 *  columns where the display value is the only one, e.g. the id. */
	firstCol(name: string): number;
}

export function indexHeader(header: string[]): CsvIndex {
	const last = new Map<string, number>();
	const first = new Map<string, number>();
	header.forEach((name, i) => {
		const key = name.trim();
		last.set(key, i);
		if (!first.has(key)) first.set(key, i);
	});
	return {
		header,
		col: (name) => last.get(name) ?? -1,
		firstCol: (name) => first.get(name) ?? -1,
	};
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

export interface StravaCsvRow {
	activityId: string;
	/** `activities/12345.fit.gz`, relative to the archive root. Empty for a
	 *  manual entry with no upload — a real and normal case. */
	filename: string | null;
	type: string;
	name: string | null;
	description: string | null;
	privateNote: string | null;
	gear: string | null;
	/** Strava writes this as a UTC instant, despite reading like a local time. */
	startedAt: string;
	/** Every numeric column, by header name, precise copy. Kept whole so the
	 *  `raw` provenance column can hold what the provider actually said. */
	values: Record<string, string>;
}

export function readRow(cells: string[], idx: CsvIndex): StravaCsvRow | null {
	const get = (name: string): string => (idx.col(name) >= 0 ? (cells[idx.col(name)] ?? '').trim() : '');
	const getFirst = (name: string): string => (idx.firstCol(name) >= 0 ? (cells[idx.firstCol(name)] ?? '').trim() : '');

	const activityId = getFirst('Activity ID');
	if (!activityId) return null;

	const values: Record<string, string> = {};
	idx.header.forEach((name, i) => {
		const v = (cells[i] ?? '').trim();
		if (v !== '') values[name.trim()] = v;
	});

	return {
		activityId,
		filename: get('Filename') || null,
		type: getFirst('Activity Type'),
		name: getFirst('Activity Name') || null,
		description: getFirst('Activity Description') || null,
		privateNote: getFirst('Activity Private Note') || null,
		gear: getFirst('Activity Gear') || null,
		startedAt: getFirst('Activity Date'),
		values,
	};
}

/** "Aug 20, 2026, 11:01:45 AM" — Strava's export format, and a UTC instant
 *  regardless of how local it reads. `Date.parse` handles the shape, but not
 *  the zone, so the parsed fields are re-assembled as UTC explicitly. */
export function parseStravaDate(s: string): string | null {
	const m = /^(\w{3})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(s.trim());
	if (!m) {
		const t = Date.parse(s);
		return Number.isFinite(t) ? new Date(t).toISOString() : null;
	}
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const month = months.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
	if (month < 0) return null;
	let hour = Number(m[4]) % 12;
	if (m[7].toUpperCase() === 'PM') hour += 12;
	return new Date(Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]), Number(m[6]))).toISOString();
}

// ---------------------------------------------------------------------------
// Row → canonical
// ---------------------------------------------------------------------------

const n = (v: string | undefined): number | null => {
	if (v === undefined || v === '') return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
};

/**
 * The CSV alone, with no file behind it — the fallback for a manual entry, and
 * the base every parsed file is layered on top of.
 *
 * Strava's own `Relative Effort` and `Training Load` columns are deliberately
 * NOT read. They are Strava's effort model, computed by a method we cannot
 * state and cannot recompute; §3's whole claim is that `exertion` travels with
 * an `exertion_method` and an `exertion_confidence`. Borrowing a number that
 * can carry neither would quietly undermine the one axis this section sorts on.
 */
export function csvRowToCanonical(row: StravaCsvRow): CanonicalActivity | null {
	const startedAt = parseStravaDate(row.startedAt);
	if (!startedAt) return null;

	const v = row.values;
	const sport = sportFromStrava(row.type);

	return {
		sport,
		title: row.name,
		notes: row.description,
		private_notes: row.privateNote,
		started_at: startedAt,

		elapsed_seconds: Math.round(n(v['Elapsed Time']) ?? 0),
		moving_seconds: n(v['Moving Time']),
		distance_m: n(v['Distance']),
		elevation_gain_m: n(v['Elevation Gain']),
		elevation_loss_m: n(v['Elevation Loss']),
		elev_high_m: n(v['Elevation High']),
		elev_low_m: n(v['Elevation Low']),

		avg_speed_ms: n(v['Average Speed']),
		max_speed_ms: n(v['Max Speed']),
		avg_hr: n(v['Average Heart Rate']),
		max_hr: n(v['Max Heart Rate']),
		avg_cadence: n(v['Average Cadence']),
		avg_power_w: n(v['Average Watts']),
		max_power_w: n(v['Max Watts']),
		normalized_power_w: n(v['Weighted Average Power']),
		work_kj: n(v['Total Work']) !== null ? n(v['Total Work'])! / 1000 : null,
		calories: n(v['Calories']),
		avg_temp_c: n(v['Average Temperature']),
		pool_length_m: n(v['Pool Length']),
	};
}

/**
 * The file's measurements win where it has them; the CSV supplies the rest.
 *
 * The direction of that merge is the point. A device file is the primary
 * record — it is what the sensors actually saw, at full resolution — while the
 * CSV is Strava's summary of it. But the CSV is where the athlete's own
 * writing lives (title, description, private note) and where a gear
 * assignment made on the website lives, none of which the file can know. So:
 * measurements from the file, editorial from the CSV.
 */
export function mergeCanonical(fromFile: CanonicalActivity, fromCsv: CanonicalActivity): CanonicalActivity {
	const merged: CanonicalActivity = { ...fromCsv, ...stripNulls(fromFile) };

	// Editorial always comes from the CSV, even when the file carried a name —
	// a head unit's "Morning Ride" must never overwrite a title the athlete
	// typed, and `fromFile.title` is exactly that kind of default.
	merged.title = fromCsv.title ?? fromFile.title ?? null;
	merged.notes = fromCsv.notes ?? null;
	merged.private_notes = fromCsv.private_notes ?? null;

	// The file is the authority on sport refinement (indoor vs outdoor, §7's
	// "does this draw a route"), which is the one place `refineSport` already
	// let it speak.
	merged.sport = fromFile.sport;
	merged.sub_sport = fromFile.sub_sport ?? null;

	return merged;
}

function stripNulls(a: CanonicalActivity): Partial<CanonicalActivity> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined) out[k] = v;
	return out as Partial<CanonicalActivity>;
}
