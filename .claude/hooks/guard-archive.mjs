// The permissions in .claude/settings.json deny Read/Edit/Write under
// src/pages/archive/, but a shell command (cat, sed, grep, rm) walks straight
// past them. This closes that door: any Bash command naming the archive
// directory is blocked before it runs.
//
// ponytail: substring match, not a parsed command line. It over-blocks (a
// command that merely mentions the path in a comment is refused too), which is
// the right way to fail for a directory nothing is supposed to touch.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

const cmd = JSON.parse(raw || '{}').tool_input?.command ?? '';

if (/src[\/\\]pages[\/\\]archive[\/\\]/.test(cmd)) {
	console.error(
		'Blocked: src/pages/archive/ holds retired features, frozen as they were. ' +
			'Do not read, edit or delete anything in it — see CLAUDE.md. ' +
			'The archive listing at src/pages/archive.astro is the editable part.',
	);
	process.exit(2);
}
