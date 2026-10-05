#!/usr/bin/env bash
# Spike #148: makes, stops, starts and removes the spike's Sandboxes, all named spike148-…, laid
# out as ADR 0013 has a Session's (spike #142's vm.sh): the Workspace, a git repo, is a host
# directory at /workspace; Claude Code's Linux build is the Runner's read-only cache mount; its
# state (CLAUDE_CONFIG_DIR) is on a per-Session disk volume. The probe and control mods are mounted read-only.
#
#   spikes/148/vm.sh create <name>
#   spikes/148/vm.sh stop|start|rm <name>
#   spikes/148/vm.sh clean                 # removes every spike148 VM and volume
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
claude_cache=${CLAUDE_CACHE:-$HOME/.claude-hub/claude-code/2.1.289-glibc}
image=${SPIKE148_IMAGE:-buildpack-deps:bookworm}
cmd=$1
name=${2:-}

case "$cmd" in
create)
  [[ $name == spike148-* ]] || {
    echo "name must start with spike148-" >&2
    exit 2
  }
  workspace=/private/tmp/spike148/workspaces/$name
  if [[ ! -d $workspace/.git ]]; then
    mkdir -p "$workspace"
    git -C "$workspace" init -q -b main
    printf 'def add(a, b):\n    return a + b\n' >"$workspace/calc.py"
    printf '# spike148\n' >"$workspace/README.md"
    git -C "$workspace" add -A
    git -C "$workspace" -c user.name=spike -c user.email=spike@example.com commit -qm "Initial commit"
    git -C "$workspace" switch -qc work
  fi
  msb volume create "$name-state" --kind disk --size 1G -q 2>/dev/null || true
  msb create "$image" -n "$name" -c 2 -m 2G --net all -q --replace \
    -v "$workspace:/workspace" \
    -v "$claude_cache:/opt/claude-code:ro" \
    -v "$here:/opt/spike148:ro" \
    --mount-named "$name-state:/var/lib/claude-state:kind=disk,size=1G" \
    -w /workspace
  msb exec "$name" -- sh -c 'command -v tmux >/dev/null || { apt-get update -qq >/dev/null && apt-get install -y -qq tmux >/dev/null 2>&1; }; mkdir -p /var/lib/claude-state/config; git config --global user.name spike; git config --global user.email spike@example.com; git config --global --add safe.directory "*"; tmux -V; git --version'
  ;;
stop) msb stop "$name" ;;
start) msb start "$name" ;;
rm)
  msb rm -f "$name" 2>/dev/null || msb rm "$name"
  msb volume rm "$name-state" 2>/dev/null || true
  ;;
clean)
  for vm in $(msb ls 2>/dev/null | awk '$1 ~ /^spike148-/ {print $1}'); do
    msb stop "$vm" 2>/dev/null || true
    msb rm "$vm" 2>/dev/null || true
  done
  for vol in $(msb volume ls 2>/dev/null | awk '$1 ~ /^spike148-/ {print $1}'); do
    msb volume rm "$vol" || true
  done
  ;;
*)
  echo "usage: vm.sh create|stop|start|rm|clean [name]" >&2
  exit 2
  ;;
esac
