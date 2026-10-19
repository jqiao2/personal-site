// /films/rank's pivot choice: similar films first, and the search still converges.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/film-rank.test.mjs
import assert from 'node:assert/strict';
import { pickPivot, similarity } from '../src/lib/film-rank-pick.ts';

const film = (id, o = {}) => ({ id, title: `F${id}`, year: 1950, poster: null, directors: [`d${id}`], actors: [], genres: [], ...o });

const nolan = film(0, { directors: ['Nolan'], genres: ['Drama'], year: 2010 });

assert.ok(similarity(nolan, film(1, { directors: ['Nolan'] })) > similarity(nolan, film(2, { genres: ['Drama'], year: 2010 })), 'director outweighs genre + era');

// A ranked list of 100 with one Nolan inside the middle half and one outside it.
const ranked = Array.from({ length: 100 }, (_, i) => film(i + 1));

ranked[30] = film(31, { directors: ['Nolan'] });

ranked[5] = film(6, { directors: ['Nolan'] });

assert.equal(pickPivot(ranked, 0, 100, nolan), 30, 'the similar film inside the middle half is the pivot');

assert.equal(pickPivot(ranked, 0, 100, film(999)), 50, 'nothing alike: the midpoint');

// Insert 200 films with random true scores; every one must land in sorted order.
const score = new Map();

let order = [];

for (let i = 0; i < 200; i++) {
	const f = film(1000 + i, { directors: [`d${i % 7}`], genres: [`g${i % 3}`], year: 1950 + (i % 40) });

	score.set(f.id, Math.random());

	let lo = 0;
	let hi = order.length;
	let asked = 0;

	while (lo < hi) {
		const p = pickPivot(order, lo, hi, f);

		assert.ok(p >= lo && p < hi, 'pivot inside the open range');

		if (score.get(f.id) > score.get(order[p].id)) hi = p;
		else lo = p + 1;
		asked++;
	}

	assert.ok(asked <= Math.ceil(Math.log(order.length + 1) / Math.log(4 / 3)) + 1, 'at most a quarter of the range survives each answer');
	order = [...order.slice(0, lo), f, ...order.slice(lo)];
}

for (let i = 1; i < order.length; i++) assert.ok(score.get(order[i - 1].id) >= score.get(order[i].id), 'ranked best first');

console.log('film-rank ok');
