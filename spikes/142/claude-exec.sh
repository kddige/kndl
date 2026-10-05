#!/usr/bin/env bash
# Runs a command in a spike Sandbox with Claude Code's proxy environment: the base URL of the
# credential proxy on the host and the Session's dummy token. Both are passed to this one process
# (msb exec -e), never stored on the VM.
#
#   spikes/142/claude-exec.sh <sandbox> <dummy-file> [msb exec flags…] -- <command…>
set -euo pipefail
sandbox=$1
dummy_file=$2
shift 2
port=${SPIKE142_PORT:-18142}
exec msb exec "$sandbox" \
  -e "ANTHROPIC_BASE_URL=http://host.microsandbox.internal:${port}" \
  -e "CLAUDE_CODE_OAUTH_TOKEN=$(cat "$dummy_file")" \
  -e "HOME=/root" \
  -e "TERM=xterm-256color" \
  ${SPIKE142_EXTRA_ENV:+$SPIKE142_EXTRA_ENV} \
  "$@"
