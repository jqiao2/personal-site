// Install the reading-sync plugin onto a mounted Kindle, pre-configured.
//
// Copies koreader-plugin/readingsync.koplugin/ into <kindle>/koreader/plugins/
// and writes the plugin's settings file already filled in, so nothing has to be
// typed on the device. That last part is the whole point: the sync token is 64
// hex characters and the alternative is entering it on an e-ink keyboard.
//
// The settings file is KOReader's own LuaSettings format — `-- <path>` followed
// by `return { ["key"] = "value", }` — which it reads with dofile(). Written
// here exactly as KOReader would write it, so the plugin cannot tell the
// difference and rewrites it normally the first time you change a setting.
//
// Refuses to write anywhere that doesn't look like a KOReader install, because
// the argument is a drive letter and drive letters move around.
//
// Usage:
//   node --env-file=.env scripts/reading-plugin-install.mjs --dest F:/
//   node --env-file=.env scripts/reading-plugin-install.mjs --dest F:/ --dry-run
//
//   --url URL       site to sync to (default https://jqiao.vercel.app)
//   --device NAME   device label on every session (default kindle-pw5)
//   --force         overwrite an existing settings file (default: leave it)
//   --dry-run       report, write nothing

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', 'koreader-plugin', 'readingsync.koplugin');

const args = parseArgs(process.argv.slice(2));
const dest = typeof args.dest === 'string' ? args.dest : null;
if (!dest) {
	console.error('--dest <kindle root> is required, e.g. --dest F:/');
	process.exit(1);
}

const opts = {
	url: String(args.url ?? 'https://jqiao.vercel.app').replace(/\/+$/, ''),
	device: String(args.device ?? 'kindle-pw5'),
	dryRun: !!args['dry-run'],
	force: !!args.force,
};

const token = process.env.READING_SYNC_TOKEN;
if (!token) {
	console.error('READING_SYNC_TOKEN is not set (try: node --env-file=.env …)');
	process.exit(1);
}

// --- is this actually a Kindle running KOReader? ----------------------------
const koreader = join(dest, 'koreader');
const settingsDir = join(koreader, 'settings');
const pluginsDir = join(koreader, 'plugins');

if (!existsSync(dest)) {
	console.error(`${dest} is not mounted. Plug the Kindle in and check the drive letter.`);
	process.exit(1);
}
if (!existsSync(koreader) || !statSync(koreader).isDirectory()) {
	console.error(`${dest} has no koreader/ directory — is this the right drive?`);
	console.error(`It contains: ${readdirSync(dest).slice(0, 12).join(', ')}`);
	process.exit(1);
}
if (!existsSync(settingsDir)) {
	console.error(`${koreader} has no settings/ directory — KOReader may never have been run.`);
	process.exit(1);
}

const statsDb = join(settingsDir, 'statistics.sqlite3');
console.log(`KOReader found at ${koreader}`);
console.log(
	existsSync(statsDb)
		? `  statistics.sqlite3 present (${(statSync(statsDb).size / 1024).toFixed(0)} KB)`
		: '  no statistics.sqlite3 yet — it appears once you have read a few pages',
);

// --- the plugin -------------------------------------------------------------
const target = join(pluginsDir, 'readingsync.koplugin');
const files = readdirSync(SOURCE);
console.log(`\nplugin  ${target}`);
for (const f of files) console.log(`          ${f}`);

if (!opts.dryRun) {
	mkdirSync(pluginsDir, { recursive: true });
	cpSync(SOURCE, target, { recursive: true });
}

// --- the settings file ------------------------------------------------------
const settingsPath = join(settingsDir, 'readingsync.lua');
const exists = existsSync(settingsPath);

console.log(`\nsettings  ${settingsPath}`);
console.log(`          server_url = ${opts.url}`);
console.log(`          device     = ${opts.device}`);
console.log(`          sync_token = ${token.slice(0, 4)}… (${token.length} chars, not shown)`);

if (exists && !opts.force) {
	console.log('          EXISTS — left alone. Pass --force to overwrite.');
} else if (!opts.dryRun) {
	writeFileSync(settingsPath, luaSettings(settingsPath, {
		server_url: opts.url,
		sync_token: token,
		device: opts.device,
		sync_on_close: true,
		sync_on_suspend: true,
	}), 'utf8');
}

console.log(
	opts.dryRun
		? '\ndry run — nothing written'
		: '\ninstalled. Eject the Kindle, then restart KOReader (exit to the launcher and back in).' +
			'\nCheck Tools -> Reading sync: the server and token should already be filled in.',
);

// ---------------------------------------------------------------------------

/**
 * KOReader's LuaSettings on-disk format, reproduced. It reads these with
 * dofile(), so the file has to *return* the table; the leading comment is the
 * file's own path, which is what KOReader writes.
 */
function luaSettings(path, data) {
	const lines = Object.entries(data).map(
		([k, v]) => `    [${quote(k)}] = ${typeof v === 'string' ? quote(v) : String(v)},`,
	);
	return `-- ${path}\nreturn {\n${lines.join('\n')}\n}\n`;
}

/** Lua's string.format("%q", …): quotes, backslashes and newlines escaped. */
function quote(s) {
	return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}
