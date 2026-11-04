# 0036 — Scripted string edits miss in CRLF files

**Type:** failure-mode
**Applies when:** editing source with a node/sed script on this Windows checkout, especially a multi-line match.

## Symptom
A node `replace()` script edited some files and did nothing to others. In `strava/sync.ts` one replace worked and the next did not, which left a new `import { isCron }` next to the old local `function isCron`, and `astro check` reported TS2440.

## Root cause
Files here are a mix of LF and CRLF on disk. A pattern containing `\n` can't match across `\r\n`, and `String.replace` gives no sign of a miss. Single-line patterns still match, so the edit applies in part.

## Fix
Use the Edit tool for anything multi-line. It matches CRLF files. In a script, compare before and after for each replacement and throw on a miss, per replacement and not per file.

## Seen
- 2026-11-04 — recipes library: `nav.ts`, `SiteHeader.astro` and `strava/sync.ts`.
