// Per-person career derivations shared by the credit-graph builders.
//
// These are copied VERBATIM from scripts/credit-graph/build.mjs (the corpus
// page's builder) so the watched-films enrichment (build-film-enrichment.mjs)
// produces region / era / prominence with exactly the same meaning. build.mjs
// keeps its own inline copy and is deliberately left untouched — if you change a
// definition here, change it there too, or the two pages will disagree. The long
// rationale for each choice lives in build.mjs; this file is just the mechanics.

// ---------------------------------------------------------------------------
// Region (production country) colour dimension
// ---------------------------------------------------------------------------

export const NEUTRAL = '#9A9A95';

/** The repeating four, chosen to stay separable under colour blindness. */
export const CYCLE = [
	'#E69F00', // orange
	'#4400DD', // blue-violet
	'#56B4E9', // sky
	'#B03060', // maroon
];

const COUNTRY_LIST = [
	{ code: 'US', label: 'United States' },
	{ code: 'FR', label: 'France' },
	{ code: 'GB', label: 'United Kingdom' },
	{ code: 'IT', label: 'Italy' },
	{ code: 'JP', label: 'Japan' },
	{ code: 'IN', label: 'India' },
	{ code: 'DE', label: 'Germany', also: ['DD'] },
	{ code: 'KR', label: 'South Korea' },
	{ code: 'ES', label: 'Spain' },
	{ code: 'CA', label: 'Canada' },
	{ code: 'HK', label: 'Hong Kong' },
	{ code: 'AU', label: 'Australia' },
	{ code: 'RU', label: 'Russia / USSR', also: ['SU'] },
	{ code: 'MX', label: 'Mexico' },
	{ code: 'CN', label: 'China' },
	{ code: 'PL', label: 'Poland' },
	{ code: 'BR', label: 'Brazil' },
	{ code: 'TR', label: 'Turkey' },
	{ code: 'DK', label: 'Denmark' },
	{ code: 'SE', label: 'Sweden' },
	{ code: 'BE', label: 'Belgium' },
	{ code: 'NO', label: 'Norway' },
	{ code: 'IE', label: 'Ireland' },
	{ code: null, label: 'Elsewhere' },
];

export const COUNTRIES = COUNTRY_LIST.map((c, i) => ({
	...c,
	color: c.code ? CYCLE[i % CYCLE.length] : NEUTRAL,
}));
export const COUNTRY_OF = new Map(
	COUNTRIES.flatMap((c, i) => (c.code ? [c.code, ...(c.also ?? [])].map((k) => [k, i]) : [])),
);
export const OTHER_COUNTRY = COUNTRIES.findIndex((c) => !c.code);
export const COUNTRY_MIN_FILMS = 3;

/** Dominant country bucket + every bucket with COUNTRY_MIN_FILMS+ films, each
 * film's weight split across its production countries. Returns bucket indices
 * into COUNTRIES. */
export function countryProfile(filmIds, filmById) {
	const tally = new Map();
	for (const id of filmIds) {
		const codes = filmById.get(id)?.countries ?? [];
		if (!codes.length) continue;
		const share = 1 / codes.length;
		for (const code of codes) tally.set(code, (tally.get(code) ?? 0) + share);
	}
	if (!tally.size) return { dominant: OTHER_COUNTRY, members: [OTHER_COUNTRY] };

	const byBucket = new Map();
	for (const [code, n] of tally) {
		const b = COUNTRY_OF.get(code) ?? OTHER_COUNTRY;
		byBucket.set(b, (byBucket.get(b) ?? 0) + n);
	}

	let dominant = OTHER_COUNTRY;
	let best = -1;
	const members = [];
	for (const [bucket, n] of byBucket) {
		if (n > best) {
			best = n;
			dominant = bucket;
		}
		if (n >= COUNTRY_MIN_FILMS && bucket !== OTHER_COUNTRY) members.push(bucket);
	}
	if (!members.includes(dominant)) members.push(dominant);
	return { dominant, members: members.sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Era colour dimension
// ---------------------------------------------------------------------------

export const ERAS = [
	{ key: 'silent', label: 'Silent, to 1928', until: 1928, light: '#7AD151', dark: '#FDE725' },
	{ key: 'studio', label: 'Studio era, 1929–59', until: 1959, light: '#22A884', dark: '#5EC962' },
	{ key: 'newhw', label: 'New Hollywood, 1960–80', until: 1980, light: '#2A788E', dark: '#21918C' },
	{ key: 'blockbuster', label: 'Blockbuster, 1981–99', until: 1999, light: '#414487', dark: '#3B528B' },
	{ key: 'modern', label: 'Modern, 2000–', until: Infinity, light: '#440154', dark: '#7E6FC4' },
];

/** Era bucket index by the median release year of a filmography. */
export function careerEra(filmIds, filmById) {
	const years = [...filmIds]
		.map((id) => filmById.get(id)?.year)
		.filter((y) => y)
		.sort((a, b) => a - b);
	if (!years.length) return ERAS.length - 1;
	const median = years[Math.floor(years.length / 2)];
	return ERAS.findIndex((e) => median <= e.until);
}

// ---------------------------------------------------------------------------
// Prominence (era-adjusted percentiles)
// ---------------------------------------------------------------------------

const MIN_WINDOW = 30;
const SHRINKAGE = 3;

/** Per-film percentile of `field` within a ±2-year (widening) window of
 * contemporaries, plus the corpus mean as a shrinkage prior. */
export function eraPercentiles(films, field, requirePositive) {
	const value = (f) => f[field] ?? 0;
	const usable = (f) => f.year && (!requirePositive || value(f) > 0);

	const byYear = new Map();
	for (const f of films) {
		if (!usable(f)) continue;
		if (!byYear.has(f.year)) byYear.set(f.year, []);
		byYear.get(f.year).push(value(f));
	}
	for (const arr of byYear.values()) arr.sort((a, b) => a - b);

	const windows = new Map();
	const windowFor = (year) => {
		let cached = windows.get(year);
		if (cached) return cached;
		let span = 2;
		let merged = [];
		for (;;) {
			merged = [];
			for (let y = year - span; y <= year + span; y++) {
				const arr = byYear.get(y);
				if (arr) merged.push(...arr);
			}
			if (merged.length >= MIN_WINDOW || span > 60) break;
			span++;
		}
		merged.sort((a, b) => a - b);
		windows.set(year, merged);
		return merged;
	};

	const scores = new Map();
	let total = 0;
	let n = 0;
	for (const f of films) {
		if (!usable(f)) {
			scores.set(f.id, null);
			continue;
		}
		const w = windowFor(f.year);
		if (w.length < 2) {
			scores.set(f.id, null);
			continue;
		}
		const v = value(f);
		let lo = 0;
		let hi = w.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (w[mid] < v) lo = mid + 1;
			else hi = mid;
		}
		const p = lo / (w.length - 1);
		scores.set(f.id, p);
		total += p;
		n++;
	}
	return { scores, prior: n ? total / n : 0.5 };
}

/** Shrunk mean of a person's per-film percentiles. */
export function shrunkMean(sum, count, prior) {
	return (sum + SHRINKAGE * prior) / (count + SHRINKAGE);
}

/** The colour-mode legends the client renders, derived from the tables above. */
export function regionLegend() {
	return COUNTRIES.map((c) => ({ label: c.label, light: c.color, dark: c.color }));
}
export function eraLegend() {
	return ERAS.map((e) => ({ label: e.label, light: e.light, dark: e.dark }));
}
