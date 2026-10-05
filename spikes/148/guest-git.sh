#!/bin/sh
# Spike #148: what git inside the Sandbox sees of a subagent's worktree in /workspace.
# Run with: msb exec <vm> -- sh /opt/spike148/guest-git.sh
cd /workspace || exit 1
echo "== status"
git status --short --branch
echo "== worktree list"
git worktree list
echo "== worktree status"
for wt in .claude/worktrees/*; do
  [ -d "$wt" ] && git -C "$wt" status --short --branch
done
echo "== add --all to a scratch index"
GIT_INDEX_FILE=/tmp/spike148-index git add --all 2>&1
GIT_INDEX_FILE=/tmp/spike148-index git ls-files -s
rm -f /tmp/spike148-index
