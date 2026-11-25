// Every page header uses the --ph-* dimensions from SiteHeader.astro. Runs at
// the front of `npm run build`, so a page that picks its own numbers fails the
// deploy. See "Page headers" in CLAUDE.md.
//
// ponytail: regexes over the page's own <style>, not a CSS parser. It knows the
// class names pages use today; a title under a new class name gets past it.
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';

// Titles beside artwork or on a floating panel, which keep their own size.
const OWN_TITLE = new Set([
	'activities/[id].astro',
	'activities/gear/[id].astro',
	'books/[id].astro',
	'films/diary/[id].astro',
	'films/movie/[tmdbId].astro',
	'projects/credit-network.astro',
	'projects/film-credit-network.astro',
	'restaurants/place/[id].astro',
]);

export function problems(source, ownTitle = false) {
	const found = [];
	const css = source.replace(/\/\*[\s\S]*?\*\//g, '');

	for (const [, selector, body] of css.matchAll(/([^{};>]+)\{([^{}]*)\}/g)) {
		const size = body.match(/(?:^|[;\s])font(?:-size)?:\s*([^;]+)/)?.[1];

		if (!ownTitle && /(?:\bh1|(?:^|[ ,])\.(?:rl-)?head__title)\s*(?:,|$)/.test(selector.trim()) && size && !size.includes('var(--ph-title)')) {
			found.push(`title is ${size}, not var(--ph-title)`);
		}

		const padding = body.match(/(?:^|[;\s])padding(?:-top)?:\s*([^;]+)/)?.[1];

		if (!padding) continue;

		if (selector.trim().endsWith('topbar') && !padding.startsWith('var(--ph-top)')) {
			found.push(`.topbar padding is ${padding}, not var(--ph-top)`);
		}

		const box = source.indexOf('class="page"');
		const inside = box !== -1 && source.indexOf('<SiteHeader') > box;

		if (inside && selector.trim().endsWith('.page') && !/^0(?:px)?(?:\s|$)/.test(padding)) {
			found.push(`.page padding ${padding} pushes SiteHeader down`);
		}
	}

	return found;
}

const bad = '<div class="page"><SiteHeader /></div><style>.page { padding: 3rem; } h1 { font-size: 52px; } .topbar { padding: 26px 0; }</style>';

if (problems(bad).length !== 3) throw new Error('page-header check no longer catches a bad page');

// Layouts too: the restaurant log keeps its page header in one.
const pages = ['layouts', 'pages'].flatMap((dir) =>
	readdirSync(`src/${dir}`, { recursive: true })
		.map((f) => f.replaceAll(sep, '/'))
		.filter((f) => f.endsWith('.astro') && !f.startsWith('archive/'))
		.map((name) => ({ name, path: `src/${dir}/${name}` })),
);

const failures = pages.flatMap(({ name, path }) =>
	problems(readFileSync(path, 'utf8'), OWN_TITLE.has(name)).map((p) => `${path}: ${p}`),
);

if (failures.length) {
	console.error(failures.join('\n'));
	process.exit(1);
}

console.log(`page headers: ${pages.length} files ok`);
