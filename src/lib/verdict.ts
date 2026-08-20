// The return verdict — the signature primitive of the restaurant log.
//
// Films get a heart and a rewatch arrow, books get a shelf; this gets a ladder.
// Six steps, strictly ordered, best first, stored as the rank 0–5 (see
// migration 0030 for the column). The order is settled and is NOT "how likely a
// return is" — it is how much of the visit I would repeat:
//
//   * "Worth returning" outranks "Happy to go" because the wanting is there and
//     only cost or distance is in the way. "Happy to go" has no wanting in it;
//     the occasion has to come from someone else. Fewer barriers, higher rung.
//   * "Definitely return" outranks "Try something else" because it repeats the
//     whole visit, dish included. Keeping the restaurant and throwing out the
//     order is strictly less enthusiasm about the meal actually eaten.
//
// THE MARK. Each rung is drawn as a needle in a ring, rotated `rank * 36°` from
// straight up — six steps sweeping a half turn, so the top rung points at the
// ceiling and the bottom one points at the floor. That is what makes the badge
// legible at 20px with no label: you read the angle, not the glyph. Do not
// re-space the angles; six rungs over 180° is what keeps adjacent rungs 36°
// apart, which is the smallest difference that survives at badge size.
//
// The heart is not a seventh step. It is a separate flag that can sit on any
// rung, including a low one, and it means love rather than likelihood.

export interface Verdict {
	/** Ordinal rank, 0 (best) – 5 (worst). The stored value. */
	rank: number;
	/** Stable identifier for URLs and filter params. */
	slug: string;
	label: string;
	/** The one-line meaning. Composer only — nowhere else on the site explains
	    a verdict; the label carries it everywhere it is read. */
	gloss: string;
	/** Ink for the mark. Three bands: going back, hesitating, not going back. */
	ink: string;
}

export const VERDICTS: readonly Verdict[] = [
	{
		rank: 0,
		slug: 'definitely-return',
		label: 'Definitely return',
		gloss: "I'd come back and order the same thing again",
		ink: '#556b2a',
	},
	{
		rank: 1,
		slug: 'worth-returning',
		label: 'Worth returning',
		gloss: "I'd come back of my own accord, but it's too expensive or too far to be likely",
		ink: '#556b2a',
	},
	{
		rank: 2,
		slug: 'try-something-else',
		label: 'Try something else',
		gloss: "I'd come back, but I wouldn't order what I ordered",
		ink: '#c07d14',
	},
	{
		rank: 3,
		slug: 'happy-to-go',
		label: 'Happy to go',
		gloss: "I wouldn't pick it myself, but I'd go if someone else suggested it",
		ink: '#c07d14',
	},
	{
		rank: 4,
		slug: 'no-return',
		label: 'No return',
		gloss: 'Would not go again',
		ink: '#a83a22',
	},
	{
		rank: 5,
		slug: 'avoid',
		label: 'Avoid',
		gloss: 'Would actively recommend that others not go',
		ink: '#a83a22',
	},
];

/** Degrees per rung. Six rungs sweep 180°, from straight up to straight down. */
export const VERDICT_STEP_DEGREES = 36;

/** The verdict at `rank`, or null for null/out-of-range. */
export function verdictAt(rank: number | null | undefined): Verdict | null {
	if (rank == null || !Number.isInteger(rank)) return null;
	return VERDICTS[rank] ?? null;
}

/** The verdict with this slug, or null. Used to parse filter params. */
export function verdictBySlug(slug: string | null | undefined): Verdict | null {
	if (!slug) return null;
	return VERDICTS.find((v) => v.slug === slug) ?? null;
}

/** The SVG transform that points the needle at `rank`. */
export function verdictRotation(rank: number): string {
	return `rotate(${rank * VERDICT_STEP_DEGREES} 12 12)`;
}

/**
 * The filter the list and map share: "this rung or better". Named for the rung
 * it starts at, because "worth returning or better" is how you'd say it out
 * loud, and phrased against ranks where lower is better.
 */
export function atLeast(rank: number): (verdict: number | null) => boolean {
	return (verdict) => verdict != null && verdict <= rank;
}

/** Label for a "rung or better" threshold, e.g. "Worth returning or better". */
export function thresholdLabel(rank: number): string {
	const v = verdictAt(rank);
	if (!v) return 'Any verdict';
	return v.rank === 0 ? v.label : `${v.label} or better`;
}
