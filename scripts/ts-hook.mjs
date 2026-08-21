// Lets a plain-node script `import` the site's own TypeScript modules.
//
// Node 24 strips TypeScript types natively, so `import('../src/lib/sports.ts')`
// already works. The one thing it won't do is resolve TypeScript's
// extensionless import style — `import { sportMeta } from './sports'` — which
// every module under src/ uses because that is what Astro and tsc expect. This
// hook fills exactly that gap: if a relative specifier doesn't resolve, try it
// again with `.ts`.
//
// WHY THIS RATHER THAN A BUILD STEP OR tsx. The alternative that was already in
// the repo was to reimplement the logic inside the script (scripts/seed-activities.mjs
// carries its own copy of the §7 route pipeline "because this script has to run
// with plain node"). That is the expensive kind of lazy: two implementations of
// a documented algorithm that must agree forever, in a section whose whole
// premise is that exertion and route shape are computed one way. Eleven lines
// here mean the importer runs the same code the site renders.
//
// Usage:  node --import ./scripts/ts-hook.mjs --env-file=.env scripts/whatever.mjs

import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[mc]?[jt]s$/.test(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Not a TypeScript module — fall through to normal resolution so
				// a genuinely missing import still reports itself as missing.
			}
		}
		return nextResolve(specifier, context);
	},
});
