// The export's one silent failure mode: two different photographs coming out
// as the same picture.
//
// html-to-image caches every resource it fetches under the URL with the query
// string cut off (lib/dataurl.js, `getCacheKey`) unless `includeQueryParams` is
// set. `photoSrc` returns `/_vercel/image?url=…&w=320`, so every optimised
// photograph on a card is byte-identical up to the `?` and they all collapse
// onto the one cache key — the first plate fetched gets drawn on every day.
//
// It fails silently (a plausible-looking card with the wrong pictures on it),
// it only shows up in the saved PNG and not on screen, and it comes back the
// moment someone writes a new card by copying an old one's export block. So
// the check is: prove the collision is real, then prove every card that draws
// these URLs opts out of it.
//
// Run: node --import ./scripts/ts-hook.mjs scripts/export-cache-key.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { photoSrc } from '../src/lib/photo-src.ts';

// ---- 1. the collision is real -------------------------------------------
const a = photoSrc('https://photos.example.r2.dev/1/aaa.jpg', 320);
const b = photoSrc('https://photos.example.r2.dev/2/bbb.jpg', 320);

// Outside Vite `import.meta.env` is undefined, so photo-src takes its
// production branch — which is the branch that has this problem.
assert.ok(a.startsWith('/_vercel/image?'), `expected an optimised URL, got ${a}`);
assert.notEqual(a, b, 'two photographs must have two URLs');

const strip = (url) => url.replace(/\?.*/, '');
assert.equal(
	strip(a),
	strip(b),
	'if these ever stop matching, photo-src changed shape and this whole check needs rereading',
);

// ---- 2. every card that draws them opts out ------------------------------
// Any page that renders a photoSrc URL *and* rasterises itself has to pass
// includeQueryParams, or it exports the same photograph everywhere.
const CARDS = ['src/pages/month/[month].astro', 'src/pages/restaurants/month/[month].astro'];

for (const card of CARDS) {
	const source = readFileSync(card, 'utf8');
	assert.ok(source.includes('photoSrc'), `${card} no longer draws optimised photos — drop it from CARDS`);
	assert.ok(source.includes('toBlob'), `${card} no longer rasterises itself — drop it from CARDS`);
	assert.ok(
		/includeQueryParams:\s*true/.test(source),
		`${card} rasterises optimised photos without includeQueryParams — every photograph in its export will be the first one it fetched`,
	);
}

// And a card that doesn't draw them doesn't need it — stated so the list above
// reads as deliberate rather than as one somebody forgot.
for (const card of ['src/pages/films/month/[month].astro', 'src/pages/books/month/[month].astro']) {
	const source = readFileSync(card, 'utf8');
	assert.ok(
		!source.includes('photoSrc'),
		`${card} started drawing optimised photos — add it to CARDS above`,
	);
}

console.log('export-cache-key: ok');
