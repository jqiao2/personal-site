/**
 * The taste space on /films/stats: every watched film placed in 3D, and a
 * rating field smoothed over that space. Pure — no DB — so the client script
 * can import the field math and the test can run it; the loader is in
 * film-taste-load.ts.
 *
 *   x  Light ↔ Dark           tone weights
 *   y  Grounded ↔ Fantastical realism weights
 *   z  Calm ↔ Intense         energy weights
 *
 * Each axis is the mean weight over the film's genres and its TMDB keywords —
 * mood words like "melancholy" or "frantic" (migration 0073) — so a film with
 * mood tags is placed by them, and one without falls back to its genres. Each
 * axis is then stretched to [-1, 1] over the films being shown.
 */

export interface TasteFilm {
	tmdbId: number;
	title: string;
	year: number | null;
	rating: number | null;
	genres: string[];
	keywords: string[];
}

/** One film in the space. Short keys: the whole list ships to the client as JSON. */
export interface TastePoint {
	t: number;
	n: string;
	y: number | null;
	r: number | null;
	p: [number, number, number];
}

// Each table holds TMDB genres (capitalised) and keywords (lower case); a term
// not listed is neutral and doesn't count toward the mean.

// -1 light … +1 dark. Genres not listed (Action, Documentary, TV Movie) are neutral.
export const TONE = {
	cheerful: -1,
	joyful: -1,
	joyous: -1,
	feelgood: -1,
	celebratory: -0.9,
	comforting: -0.9,
	hilarious: -0.9,
	lighthearted: -0.9,
	amused: -0.8,
	euphoric: -0.8,
	exuberant: -0.8,
	optimistic: -0.8,
	playful: -0.8,
	hopeful: -0.7,
	loving: -0.7,
	vibrant: -0.7,
	whimsical: -0.7,
	enthusiastic: -0.6,
	farcical: -0.6,
	inspirational: -0.6,
	romantic: -0.6,
	adoring: -0.6,
	wonder: -0.6,
	excited: -0.5,
	mischievous: -0.5,
	witty: -0.5,
	sentimental: -0.4,
	compassionate: -0.4,
	appreciative: -0.4,
	awestruck: -0.4,
	admiring: -0.4,
	casual: -0.4,
	nostalgic: -0.3,
	empathetic: -0.3,
	absurd: -0.3,
	bittersweet: 0.2,
	reflective: 0.2,
	introspective: 0.2,
	philosophical: 0.2,
	dramatic: 0.2,
	mysterious: 0.3,
	ambiguous: 0.3,
	ambivalent: 0.3,
	critical: 0.3,
	biting: 0.4,
	cautionary: 0.4,
	provocative: 0.4,
	serious: 0.4,
	antagonistic: 0.5,
	clinical: 0.5,
	suspenseful: 0.5,
	melancholy: 0.6,
	anxious: 0.6,
	aggressive: 0.6,
	tense: 0.6,
	cold: 0.6,
	paranoid: 0.6,
	shocking: 0.7,
	dreary: 0.7,
	tragic: 0.8,
	foreboding: 0.8,
	frightened: 0.8,
	nihilism: 0.8,
	depressing: 0.9,
	disturbed: 0.9,
	dread: 0.9,
	grim: 0.9,
	horrified: 0.9,
	macabre: 0.9,
	malicious: 0.9,
	brutality: 1,
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
	'based on true story': -1,
	'true crime': -1,
	biography: -0.9,
	'historical figure': -0.9,
	surrealism: 0.7,
	surreal: 0.7,
	magic: 0.9,
	supernatural: 0.9,
} satisfies Record<string, number>;

// -1 calm … +1 intense.
export const ENERGY = {
	Action: 0.9,
	Adventure: 0.6,
	Horror: 0.6,
	Thriller: 0.6,
	War: 0.5,
	Crime: 0.3,
	'Science Fiction': 0.3,
	Animation: 0.2,
	Fantasy: 0.2,
	Comedy: 0.1,
	Family: 0.1,
	Mystery: -0.1,
	History: -0.4,
	Romance: -0.5,
	Documentary: -0.5,
	Drama: -0.6,
	calm: -1,
	reflective: -0.8,
	introspective: -0.8,
	thoughtful: -0.7,
	wistful: -0.7,
	lyrical: -0.7,
	melancholy: -0.6,
	philosophical: -0.6,
	intimate: -0.6,
	comforting: -0.6,
	dreary: -0.6,
	detached: -0.6,
	nostalgic: -0.5,
	casual: -0.5,
	sincere: -0.4,
	earnest: -0.4,
	sentimental: -0.4,
	compassionate: -0.4,
	empathetic: -0.4,
	loving: -0.4,
	depressing: -0.4,
	romantic: -0.3,
	candid: -0.3,
	ambivalent: -0.3,
	appreciative: -0.3,
	cold: -0.3,
	clinical: -0.3,
	ambiguous: -0.2,
	admiring: -0.2,
	foreboding: 0.3,
	provocative: 0.3,
	antagonistic: 0.4,
	playful: 0.4,
	mischievous: 0.4,
	joyful: 0.4,
	commanding: 0.5,
	assertive: 0.5,
	dread: 0.5,
	hilarious: 0.5,
	joyous: 0.5,
	vibrant: 0.5,
	awestruck: 0.5,
	heist: 0.5,
	bold: 0.6,
	powerful: 0.6,
	anxious: 0.6,
	enthusiastic: 0.6,
	farcical: 0.6,
	celebratory: 0.6,
	brisk: 0.6,
	fight: 0.6,
	audacious: 0.7,
	euphoric: 0.7,
	exuberant: 0.7,
	shocking: 0.7,
	frightened: 0.7,
	brutality: 0.7,
	excited: 0.8,
	tense: 0.8,
	suspenseful: 0.8,
	horrified: 0.8,
	chase: 0.8,
	gunfight: 0.8,
	shootout: 0.8,
	exhilarated: 0.9,
	aggressive: 0.9,
	urgent: 0.9,
	intense: 1,
	frantic: 1,
	chaotic: 1,
} satisfies Record<string, number>;

/** Mean weight over the terms the table knows; 0 when it knows none. */
export function termScore(terms: string[], weights: Record<string, number>): number {
	let sum = 0;

	let n = 0;

	for (const t of terms) {
		if (Object.hasOwn(weights, t)) {
			sum += weights[t];
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
	const terms = films.map((f) => [...f.genres, ...f.keywords]);
	const axis = (weights: Record<string, number>, salt: number) =>
		stretch(films.map((f, i) => termScore(terms[i], weights) + jitter(f.tmdbId, salt, 0.05)));
	const xs = axis(TONE, 1);
	const ys = axis(REALISM, 2);
	const zs = axis(ENERGY, 3);

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
