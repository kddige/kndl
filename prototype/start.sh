#!/usr/bin/env bash
# Starts the hub and this machine's runner. Ctrl-C stops both (sessions keep running in tmux).
# Other machines only need: HUB_URL=http://<this-machine>:7777 bun runner/runner.ts
set -euo pipefail
cd "$(dirname "$0")"
bun hub/server.ts &
HUB=$!
trap 'kill $HUB 2>/dev/null' EXIT
sleep 0.5
bun runner/runner.ts
