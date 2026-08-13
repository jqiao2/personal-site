// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// The site is static by default; individual routes that need a server
// (everything under src/pages/api/**) opt in with `export const prerender = false`.
// The Vercel adapter provides the serverless runtime for those routes.
// https://astro.build/config
export default defineConfig({
	adapter: vercel(),
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
