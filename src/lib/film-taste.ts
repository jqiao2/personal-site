/**
 * The taste space on /films/stats: every watched film placed in 3D, and a
 * rating field smoothed over that space. Pure — no DB — so the client script
 * can import the field math and the test can run it; the loader is in
 * film-taste-load.ts.
 *
 *   x  Light ↔ Dark          mean of the film's genre tone weights
 *   y  Grounded ↔ Fantastical mean of its genre realism weights
 *   z  Obscure ↔ Blockbuster  log TMDB vote count
 *
 * Each axis is stretched to [-1, 1] over the films being shown.
 */

export interface TasteFilm {
	tmdbId: number;
	title: string;
	year: number | null;
	rating: number | null;
	genres: string[];
	votes: number;
}

/** One film in the space. Short keys: the whole list ships to the client as JSON. */
export interface TastePoint {
	t: number;
	n: string;
	y: number | null;
	r: number | null;
	p: [number, number, number];
}

// -1 light … +1 dark. Genres not listed (Action, Documentary, TV Movie) are neutral.
export const TONE = {
	Comedy: -1,
	Family: -1,
	Music: -0.8,
	Animation: -0.6,
	Romance: -0.6,
	Adventure: -0.3,
	Fantasy: -0.2,
	'Science Fiction': 0.1,
	Drama: 0.3,
	History: 0.3,
	Western: 0.3,
	Mystery: 0.5,
	Crime: 0.7,
	Thriller: 0.8,
	War: 0.9,
	Horror: 1,
} satisfies Record<string, number>;

// -1 grounded … +1 fantastical.
export const REALISM = {
	Documentary: -1,
	History: -0.9,
	War: -0.7,
	Drama: -0.6,
	Crime: -0.5,
	Music: -0.4,
	Romance: -0.3,
	Western: -0.3,
	Thriller: -0.2,
	Comedy: -0.1,
	Action: 0.2,
	Horror: 0.4,
	Adventure: 0.5,
	Family: 0.5,
	Animation: 0.8,
	Fantasy: 1,
	'Science Fiction': 1,
} satisfies Record<string, number>;

/** Mean weight over the genres the table knows; 0 when it knows none. */
export function genreScore(genres: string[], weights: Record<string, number>): number {
	let sum = 0;

	let n = 0;

	for (const g of genres) {
		if (g in weights) {
			sum += weights[g];
			n++;
		}
	}

	return n ? sum / n : 0;
}

/** Deterministic ±amp from an id, so films with identical genres don't stack. */
function jitter(id: number, salt: number, amp: number): number {
	const h = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;

	return (h - Math.floor(h) - 0.5) * 2 * amp;
}

function stretch(values: number[]): number[] {
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const span = hi - lo || 1;

	return values.map((v) => ((v - lo) / span) * 2 - 1);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function placeFilms(films: TasteFilm[]): TastePoint[] {
	if (!films.length) return [];
	const xs = stretch(films.map((f) => genreScore(f.genres, TONE) + jitter(f.tmdbId, 1, 0.05)));
	const ys = stretch(films.map((f) => genreScore(f.genres, REALISM) + jitter(f.tmdbId, 2, 0.05)));
	const zs = stretch(films.map((f) => Math.log10(f.votes + 1)));

	return films.map((f, i) => ({
		t: f.tmdbId,
		n: f.title,
		y: f.year,
		r: f.rating,
		p: [round(xs[i]), round(ys[i]), round(zs[i])],
	}));
}

export interface TasteField {
	/** xyz per shown cell. */
	positions: Float32Array;
	/** Smoothed rating per shown cell. */
	ratings: Float32Array;
	/** 0..1, relative to the densest cell. */
	density: Float32Array;
}

/**
 * Kernel-smoothed rating over an n³ grid spanning [-1, 1]³: each cell's rating
 * is the Gaussian-weighted mean of nearby rated films, its density the sum of
 * those weights. Cells under `minDensity` (relative) are dropped — empty space
 * has no taste to show.
 */
// ponytail: O(cells × films), ~6M exps at n=18 and 1k films (~30ms); bin films first if the log grows 10×.
export function tasteField(points: TastePoint[], n = 18, sigma = 0.2, minDensity = 0.06): TasteField {
	const rated = points.filter((p) => p.r != null);
	const k = -1 / (2 * sigma * sigma);
	const cells: { pos: [number, number, number]; w: number; r: number }[] = [];
	let maxW = 0;

	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			for (let l = 0; l < n; l++) {
				const c: [number, number, number] = [(i / (n - 1)) * 2 - 1, (j / (n - 1)) * 2 - 1, (l / (n - 1)) * 2 - 1];
				let w = 0;

				let wr = 0;

				for (const p of rated) {
					const dx = p.p[0] - c[0];
					const dy = p.p[1] - c[1];
					const dz = p.p[2] - c[2];
					const g = Math.exp((dx * dx + dy * dy + dz * dz) * k);
					w += g;
					wr += g * (p.r ?? 0);
				}

				if (w > maxW) maxW = w;
				cells.push({ pos: c, w, r: w ? wr / w : 0 });
			}
		}
	}

	const shown = cells.filter((c) => maxW && c.w / maxW >= minDensity);
	const positions = new Float32Array(shown.length * 3);
	const ratings = new Float32Array(shown.length);
	const density = new Float32Array(shown.length);

	shown.forEach((c, i) => {
		positions.set(c.pos, i * 3);
		ratings[i] = c.r;
		density[i] = c.w / maxW;
	});

	return { positions, ratings, density };
}
