#!/usr/bin/env bash
# Remove the worktrees and branches left behind by agents whose PR has already
# been merged and whose branch was deleted on GitHub.
#
# An archived agent never learns its branch is gone, so its worktree and local
# branch pile up here forever. This reclaims them, on two signals that both mean
# "you already dealt with this on GitHub":
#
#   1. the branch's upstream is [gone]  — the remote branch was deleted
#   2. the branch is an ancestor of origin/main — its commits are already in main
#
# It NEVER touches a worktree with uncommitted changes, a branch with unpushed
# unique commits, or the worktree you are currently sitting in. Anything it
# deletes is recoverable from the reflog for 90 days.
#
#   bash scripts/prune-merged-worktrees.sh          # do it
#   bash scripts/prune-merged-worktrees.sh --dry-run # just show what it would do
set -euo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
cd "$(git rev-parse --show-toplevel)"
CUR="$(git -C . rev-parse --show-toplevel)"
git fetch --prune origin >/dev/null 2>&1 || true

# Windows can't rm -rf a worktree's deep node_modules (path too long); mirror an
# empty dir over it with robocopy first, then drop the husk.
force_rmdir() {
	local dir="$1"
	[ -d "$dir" ] || return 0
	if command -v robocopy >/dev/null 2>&1; then
		local empty; empty="$(mktemp -d)"
		robocopy "$empty" "$dir" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP >/dev/null 2>&1 || true
		rmdir "$empty" 2>/dev/null || true
	fi
	rm -rf "$dir" 2>/dev/null || true
}

gone() { [ "$(git for-each-ref --format='%(upstream:track)' "refs/heads/$1")" = "[gone]" ]; }
merged() { git merge-base --is-ancestor "$1" origin/main 2>/dev/null; }

# --- worktrees: remove when their branch is gone-or-merged and the tree is clean
git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
	[ "$wt" = "$CUR" ] && continue
	br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)" || continue
	[ "$br" = "HEAD" ] && continue   # detached, leave it
	gone "$br" || merged "$br" || continue
	if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
		echo "skip (uncommitted changes): $br  $wt"; continue
	fi
	if [ -n "$(git -C "$wt" log --oneline '@{u}..' 2>/dev/null)" ]; then
		echo "skip (unpushed commits): $br  $wt"; continue
	fi
	echo "remove worktree: $br  $wt"
	[ "$DRY" = 1 ] && continue
	git worktree remove --force --force "$wt" 2>/dev/null || true
	force_rmdir "$wt"
done

[ "$DRY" = 0 ] && git worktree prune

# --- branches with no worktree: delete when gone or already in main
git for-each-ref --format='%(refname:short)|%(worktreepath)' refs/heads | while IFS='|' read -r br wt; do
	[ "$br" = "main" ] && continue
	[ -n "$wt" ] && continue
	if gone "$br" || merged "$br"; then
		echo "delete branch: $br"
		[ "$DRY" = 0 ] && git branch -D "$br" >/dev/null
	fi
done

echo "done — $(git worktree list | wc -l) worktrees, $(git branch | wc -l) branches"
