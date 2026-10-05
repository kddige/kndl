#!/usr/bin/env bash
# Spike #142: makes, stops, starts and removes the spike's Sandboxes, all named spike142-…
#
#   spikes/142/vm.sh create <name> [net profile, default all]   # boots and installs tmux
#   spikes/142/vm.sh stop|start|rm <name>
#   spikes/142/vm.sh clean                                      # removes every spike142 VM+volume
#
# The layout mirrors a Session's: the Workspace is a host directory at /workspace, Claude Code's
# Linux build is the Runner's read-only cache mount, and Claude Code's own state (CLAUDE_CONFIG_DIR)
# lives on a per-Session disk volume, so it survives stop, start and re-create. The hub-link mod is
# mounted read-only too.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
claude_cache=${CLAUDE_CACHE:-$HOME/.claude-hub/claude-code/2.1.289-glibc}
image=${SPIKE142_IMAGE:-buildpack-deps:bookworm}
cmd=$1
name=${2:-}

case "$cmd" in
create)
  [[ $name == spike142-* ]] || { echo "name must start with spike142-" >&2; exit 2; }
  net=${3:-all}
  workspace=/private/tmp/spike142/workspaces/$name
  mkdir -p "$workspace"
  msb volume create "$name-state" --kind disk --size 1G -q 2>/dev/null || true
  start=$(python3 -c "import time; print(time.time())")
  msb create "$image" -n "$name" -c 2 -m 2G --net "$net" -q --replace \
    -v "$workspace:/workspace" \
    -v "$claude_cache:/opt/claude-code:ro" \
    -v "$repo/packages/mod:/opt/claude-hub/mod:ro" \
    --mount-named "$name-state:/var/lib/claude-state:kind=disk,size=1G" \
    -w /workspace
  booted=$(python3 -c "import time; print(time.time())")
  python3 -c "print(\"boot: %.2f s\" % ($booted - $start))"
  # What an Environment build would bake in: tmux, and a config dir on the state volume.
  msb exec "$name" -- sh -c 'command -v tmux >/dev/null || { apt-get update -qq >/dev/null && apt-get install -y -qq tmux >/dev/null 2>&1; }; mkdir -p /var/lib/claude-state/config; tmux -V'
  ;;
stop) msb stop "$name" ;;
start) msb start "$name" ;;
rm)
  msb rm -f "$name" 2>/dev/null || msb rm "$name"
  msb volume rm "$name-state" 2>/dev/null || true
  ;;
clean)
  for vm in $(msb ls 2>/dev/null | awk '$1 ~ /^spike142-/ {print $1}'); do
    msb stop "$vm" 2>/dev/null || true
    msb rm "$vm" 2>/dev/null || true
  done
  for vol in $(msb volume ls 2>/dev/null | awk '$1 ~ /^spike142-/ {print $1}'); do
    msb volume rm "$vol" || true
  done
  ;;
*)
  echo "usage: vm.sh create|stop|start|rm|clean [name]" >&2
  exit 2
  ;;
esac
