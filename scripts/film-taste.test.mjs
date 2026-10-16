// The taste space's placement and rating field.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/film-taste.test.mjs
import assert from 'node:assert/strict';
import { genreScore, placeFilms, tasteField, TONE, REALISM } from '../src/lib/film-taste.ts';

assert.equal(genreScore(['Comedy', 'Horror'], TONE), 0);

assert.equal(genreScore(['Action'], TONE), 0, 'unknown genres are neutral');

assert.equal(genreScore(['Fantasy'], REALISM), 1);

const films = [
	{ tmdbId: 1, title: 'Light', year: 2000, rating: 5, genres: ['Comedy', 'Family'], votes: 10 },
	{ tmdbId: 2, title: 'Dark', year: 2001, rating: 1, genres: ['Horror'], votes: 10000 },
	{ tmdbId: 3, title: 'Unrated', year: null, rating: null, genres: ['Drama'], votes: 500 },
];

const pts = placeFilms(films);

assert.ok(pts[0].p[0] < pts[1].p[0], 'comedy sits on the light side of horror');

assert.ok(pts[0].p[2] < pts[1].p[2], 'fewer votes sits lower on the mainstream axis');

for (const p of pts) for (const v of p.p) assert.ok(v >= -1 && v <= 1, 'axes stretch into [-1, 1]');

const f = tasteField(pts, 9, 0.2, 0);

assert.equal(f.positions.length, 9 ** 3 * 3);

// The cell nearest each rated film takes (roughly) that film's rating.
const nearest = (p) => {
	let best = 0;
	let bd = Infinity;

	for (let i = 0; i < f.ratings.length; i++) {
		const d = (f.positions[i * 3] - p[0]) ** 2 + (f.positions[i * 3 + 1] - p[1]) ** 2 + (f.positions[i * 3 + 2] - p[2]) ** 2;

		if (d < bd) [bd, best] = [d, i];
	}

	return f.ratings[best];
};

assert.ok(nearest(pts[0].p) > 4.5, 'loved film warms its corner');

assert.ok(nearest(pts[1].p) < 1.5, 'disliked film cools its corner');

assert.ok(Math.max(...f.density) === 1);

assert.ok(tasteField(pts, 9, 0.2, 0.5).ratings.length < 9 ** 3, 'sparse cells are dropped');

console.log('film-taste ok');
