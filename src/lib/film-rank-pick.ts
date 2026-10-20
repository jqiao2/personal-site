// The comparison logic behind /films/rank: which ranked film a new one is held
// up against next. Pure, so the page script and the test both import it.
//
// Placing a film is a binary search over the ranked list (best first), but the
// pivot isn't the exact midpoint: it is the film most like the new one among
// the middle half of the range still open. Each answer still throws away at
// least a quarter of that range, and the first questions pit the new film
// against its director's other films, shared cast, genre and era; as the range
// narrows the similar films fall out of it and the pairings drift further afield.

export interface RankFilm {
	id: number;
	title: string;
	year: number | null;
	poster: string | null;
	directors: string[];
	actors: string[];
	genres: string[];
}

const shared = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;

/** How alike two films are: director, then cast, then genre overlap, then era. */
export function similarity(a: RankFilm, b: RankFilm): number {
	let s = shared(a.directors, b.directors) > 0 ? 4 : 0;

	s += Math.min(shared(a.actors, b.actors), 3) * 1.5;

	const union = new Set([...a.genres, ...b.genres]).size;

	if (union > 0) s += (2 * shared(a.genres, b.genres)) / union;

	if (a.year != null && b.year != null) {
		const dy = Math.abs(a.year - b.year);

		s += dy <= 5 ? 1 : dy <= 10 ? 0.5 : 0;
	}

	return s;
}

/**
 * The index in `ranked` to compare `film` against, given the open range
 * [lo, hi). Ties in likeness go to whichever sits nearer the midpoint.
 */
export function pickPivot(ranked: RankFilm[], lo: number, hi: number, film: RankFilm): number {
	const n = hi - lo;
	const mid = lo + Math.floor(n / 2);

	if (n <= 3) return mid;

	const quarter = Math.floor(n / 4);
	let best = mid;
	let bestScore = -Infinity;

	for (let i = lo + quarter; i <= hi - 1 - quarter; i++) {
		const score = similarity(film, ranked[i]) - (0.5 * Math.abs(i - mid)) / quarter;

		if (score > bestScore) {
			best = i;
			bestScore = score;
		}
	}

	return best;
}

/** A film part-way through being placed: it belongs somewhere in [lo, hi) of the ranked list. */
export interface Placing {
	id: number;
	lo: number;
	hi: number;
}

// Several films are placed at once, so the list shifts under each open range.
// A film inserted inside a range is one that range's film hasn't been compared
// with yet, so the range widens to keep it in play.

/** `order` with `id` inserted at `at`; every open range is shifted to match. */
export function insertAt(order: number[], at: number, id: number, open: Placing[]): number[] {
	for (const p of open) {
		if (at < p.lo) p.lo++;

		if (at <= p.hi) p.hi++;
	}

	return [...order.slice(0, at), id, ...order.slice(at)];
}

/** `order` without the film at `at`; every open range is shifted to match. */
export function removeAt(order: number[], at: number, open: Placing[]): number[] {
	for (const p of open) {
		if (at < p.lo) p.lo--;

		if (at < p.hi) p.hi--;
	}

	return [...order.slice(0, at), ...order.slice(at + 1)];
}
