# PowerShell Get-Content/Set-Content corrupts UTF-8 source files

**Type:** failure-mode
**Applies when:** editing or truncating a repo source file with PowerShell
`Get-Content`/`Set-Content` (or `>`/`Out-File`) — especially files with non-ASCII
glyphs (`←` `…` `◎` `⇄` `—` `✕`, emoji, accented text).

## What happened

Truncated `src/pages/films/watchlist.astro` with
`(Get-Content $p)[0..N] | Set-Content $p -Encoding utf8`. Every multibyte char in
the file turned to mojibake: `←` → `â†`, `◎` → `â—Ž`, `…` → `â€¦`, `—` → `â€"`.
The page rendered the garbled bytes.

## Root cause

Windows PowerShell 5.1 `Get-Content` reads a UTF-8-without-BOM file as the system
ANSI codepage (Windows-1252), so the bytes are already wrong in memory before
`Set-Content` writes them back out as UTF-8 — a double mis-decode. `-Encoding utf8`
on the write side doesn't help; the damage is on the read. It also adds a BOM.

## Fix / avoidance

- **Don't use PowerShell (or Bash `sed`/`awk`) to rewrite whole source files.** Use
  the `Edit`/`Write` tools — they preserve UTF-8. For line-range deletes, anchor an
  `Edit` on the block's exact first/last lines instead of a line-count truncation.
- If it already happened: `git checkout -- <file>` to restore, then re-apply the
  intended changes with `Edit`. (Recoverable only if the file was committed/clean.)
- Verify after any bulk edit near non-ASCII: `grep -o "◎ Spin" <file>` (or the
  relevant glyph) should still match, and a `npm run shot` should render clean.

See [[0002-screenshot-the-page-yourself]] — the screenshot is what surfaced this.
