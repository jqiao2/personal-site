// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// The site is static by default; individual routes that need a server
// (everything under src/pages/api/**) opt in with `export const prerender = false`.
// The Vercel adapter provides the serverless runtime for those routes.
// https://astro.build/config
export default defineConfig({
	adapter: vercel(),
});
