// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { loadEnv } from 'vite';
import { PHOTO_WIDTHS } from './src/lib/photo-src.ts';

// The photo bucket's hostname, which Vercel's image optimiser has to be told
// about by name: `/_vercel/image` will only read a source from a host the
// deployment declared, which is what stops it being an open image proxy for
// the whole internet.
//
// Read from SUPABASE_URL rather than written out here so there is one place a
// project move has to be edited. `loadEnv` because astro.config runs before
// Astro has populated `import.meta.env`, and it reads .env files and the real
// environment both — which is what makes this work locally and on Vercel.
const { SUPABASE_URL } = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');
if (!SUPABASE_URL) {
	throw new Error('SUPABASE_URL is not set — the image optimiser needs the photo bucket’s hostname');
}
const photoHost = new URL(SUPABASE_URL).hostname;

// The site is static by default; individual routes that need a server
// (everything under src/pages/api/**) opt in with `export const prerender = false`.
// The Vercel adapter provides the serverless runtime for those routes.
// https://astro.build/config
export default defineConfig({
	adapter: vercel({
		// Enables `/_vercel/image` for the photo bucket. Deliberately NOT
		// `imageService: true`: that would also swap Astro's own image service
		// site-wide, which is a change to how every other page's images are
		// built for no benefit here — nothing outside the restaurant log goes
		// through the optimiser, and the URLs are assembled by hand in
		// src/lib/photo-src.ts.
		imagesConfig: {
			sizes: PHOTO_WIDTHS,
			// Host only, no pathname: the pathname field's syntax differs
			// between Vercel's configuration surfaces (glob in one, anchored
			// regexp in another) and getting it subtly wrong fails closed, as a
			// page of broken images. The host is the boundary that matters.
			remotePatterns: [{ protocol: 'https', hostname: photoHost }],
			// The stored objects are already WebP. AVIF would shave a little
			// more off and costs a much slower transform on the first request
			// for every rung; not worth it at these sizes.
			formats: ['image/webp'],
			// A stored path is `<visitId>/<timestamp>-<random>.<ext>` and is
			// never written twice, so an optimised rendition of one can be kept
			// for as long as Vercel will keep it. This is also what holds the
			// transformation count down to roughly one per photograph per
			// width, ever.
			minimumCacheTTL: 31_536_000,
		},
	}),
	// MapLibre loads its tile-decoding worker as an ES module worker. Vite's
	// default worker format is a classic IIFE, which that would fail to parse —
	// so the worker build emits ESM to match.
	vite: { worker: { format: 'es' } },
	// The book log used to live at /reading; keep the old addresses working for
	// anything already linking to them.
	redirects: {
		'/reading': '/books',
		'/reading/book/[id]': '/books/[id]',
	},
});
