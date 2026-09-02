// Screenshot a page of this site, so a change can be LOOKED AT rather than
// argued about.
//
// This exists because an agent working on the repo has no eyes. Layout work —
// the month cards especially, whose whole content is where things sit relative
// to each other — was being verified by reasoning about the CSS and then asking
// the user to paste a screenshot back. Every round trip through a human is a
// round trip in which the obvious thing goes unnoticed.
//
//   npm run shot -- month/2026-08
//   npm run shot -- films tmp/films.png --width 1400
//   npm run shot -- month/2026-08 tmp/card.png --el "[data-card]"
//   npm run shot -- activities --full
//
// Give the route WITHOUT a leading slash. Git Bash rewrites a leading-slash
// argument into a Windows path on its way to node (`/month` becomes
// `C:/Program Files/Git/month`), which is nothing this script can detect after
// the fact. A leading slash is accepted anyway for the shells that don't.
//
// Writes to tmp/shot.png unless a second argument says otherwise; tmp/ is
// git-ignored, so nothing here ends up committed by accident.
//
// It starts its own dev server on its own port and stops it again, so it never
// touches (or is confused by) a dev server another worktree is running. Owner
// gating is off in dev — `requireOwner` returns true whenever import.meta.env.DEV
// — so private pages render without a login. Real Supabase creds are still
// needed for anything that reads the database: copy the main checkout's .env
// into the worktree first (`cp ../../../.env .env`).
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dev } from 'astro';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

const path = `/${(positional[0] ?? '').replace(/^\/+/, '')}`;
const out = positional[1] ?? 'tmp/shot.png';
const width = Number(flag('width', 1280));
const height = Number(flag('height', 900));
const el = flag('el', null);
// Selectors to click before shooting, for interactive state. Repeat the flag to
// walk a UI open a step at a time: --click "[data-open-editor]" --click "#toggle".
const clicks = args.flatMap((a, i) => (a === '--click' && args[i + 1] ? [args[i + 1]] : []));
const full = args.includes('--full');

await mkdir(dirname(out), { recursive: true });

// A port of our own, high and unlikely to be taken; astro walks upward from it
// if it is, and tells us where it landed.
const server = await dev({ root: process.cwd(), server: { port: 4380 }, logLevel: 'error' });
const base = `http://localhost:${server.address.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
const problems = [];
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));

try {
	const response = await page.goto(base + path, { waitUntil: 'networkidle', timeout: 60_000 });
	console.log(`${response?.status()} ${path}`);
	// Fonts and images decide the layout of everything here, so wait for them
	// rather than for a timer.
	await page.evaluate(() => document.fonts.ready);
	for (const selector of clicks) await page.locator(selector).first().click();
	const target = el ? page.locator(el).first() : page;
	await target.screenshot({ path: out, fullPage: el ? undefined : full });
	console.log(`wrote ${out}`);
	// 404s on optimised photos are routine without the production bucket; they
	// are worth printing and not worth failing over.
	for (const problem of problems.slice(0, 10)) console.log(`  · ${problem}`);
} finally {
	await browser.close();
	await server.stop();
}
