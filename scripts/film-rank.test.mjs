// /films/rank's pivot choice: similar films first, and the search still converges.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/film-rank.test.mjs
import assert from 'node:assert/strict';
import { insertAt, pickPivot, removeAt, similarity } from '../src/lib/film-rank-pick.ts';

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

// The page's way: three films in flight at once, a random one asked each turn,
// with ranked films pulled out and dropped elsewhere along the way.
let open = [];

let queue = Array.from({ length: 200 }, (_, i) => film(5000 + i));

order = [];

for (const f of queue) score.set(f.id, Math.random());

const byId = new Map(queue.map((f) => [f.id, f]));

for (let turn = 0; queue.length || open.length; turn++) {
	while (open.length < 3 && queue.length) {
		const f = queue.shift();

		if (order.length) open.push({ id: f.id, lo: 0, hi: order.length });
		else order = [f];
	}

	// Now and then, move a ranked film to a random spot (the list editor). It's
	// put back where it belongs, so the list stays sorted while the ranges shift.
	if (turn % 7 === 0 && order.length > 2) {
		const from = Math.floor(Math.random() * order.length);
		const f = order[from];
		const ids = removeAt(order.map((x) => x.id), from, open);

		order = ids.map((id) => byId.get(id));

		const at = order.findIndex((x) => score.get(x.id) < score.get(f.id));

		order = insertAt(ids, at < 0 ? order.length : at, f.id, open).map((id) => byId.get(id));
	}

	// A move can empty a range; that film's place is then already known.
	for (const e of open.filter((x) => x.lo >= x.hi)) {
		open = open.filter((x) => x !== e);
		order = insertAt(order.map((x) => x.id), e.lo, e.id, open).map((id) => byId.get(id));
	}

	if (!open.length) continue;

	const p = open[Math.floor(Math.random() * open.length)];
	const pivot = pickPivot(order, p.lo, p.hi, byId.get(p.id));

	assert.ok(pivot >= p.lo && pivot < p.hi, 'interleaved pivot inside the open range');

	if (score.get(p.id) > score.get(order[pivot].id)) p.hi = pivot;
	else p.lo = pivot + 1;

	if (p.lo >= p.hi) {
		open = open.filter((x) => x !== p);
		order = insertAt(order.map((x) => x.id), p.lo, p.id, open).map((id) => byId.get(id));
	}
}

assert.equal(order.length, 200);

for (let i = 1; i < order.length; i++) assert.ok(score.get(order[i - 1].id) >= score.get(order[i].id), 'interleaved: ranked best first');

console.log('film-rank ok');
