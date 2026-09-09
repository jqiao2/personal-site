// Types for credit-derive.mjs (plain .mjs so node scripts can import it too).

export interface FilmFacts {
	year?: number | null;
	countries?: string[];
}
export interface LegendEntry {
	label: string;
	light: string;
	dark: string;
}

export const NEUTRAL: string;
export const CYCLE: string[];
export const COUNTRIES: { code: string | null; label: string; color: string; also?: string[] }[];
export const COUNTRY_OF: Map<string, number>;
export const OTHER_COUNTRY: number;
export const COUNTRY_MIN_FILMS: number;
export const ERAS: { key: string; label: string; until: number; light: string; dark: string }[];
export const MIN_WINDOW: number;

/** Dominant country bucket + every bucket with COUNTRY_MIN_FILMS+ films. */
export function countryProfile(
	filmIds: Iterable<number>,
	filmById: Map<number, FilmFacts>,
): { dominant: number; members: number[] };

/** Era bucket index by the median release year of a filmography. */
export function careerEra(filmIds: Iterable<number>, filmById: Map<number, FilmFacts>): number;

/** Per-film era-adjusted percentiles + the corpus mean prior. */
export function eraPercentiles(
	films: { id: number; year?: number | null; [k: string]: unknown }[],
	field: string,
	requirePositive: boolean,
): { scores: Map<number, number | null>; prior: number };

/** Shrunk mean of a person's per-film percentiles. */
export function shrunkMean(sum: number, count: number, prior: number): number;

/** Percentile (0..1) of a value within an ascending-sorted window. */
export function pctRank(value: number, sortedAsc: number[]): number | null;

export function regionLegend(): LegendEntry[];
export function eraLegend(): LegendEntry[];
