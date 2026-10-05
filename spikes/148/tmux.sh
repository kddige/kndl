#!/usr/bin/env bash
# Spike #148: Claude Code in tmux inside a spike Sandbox, with the probe and control mods and ADR 0013's
# environment, driven from the host with msb exec (spike #142's tmux.sh).
#
#   spikes/148/tmux.sh start <vm> <dummy-file> [claude args…]
#   spikes/148/tmux.sh text <vm> <text>          # types literal text, then Enter
#   spikes/148/tmux.sh prompt <vm> <name>        # types prompts/<name>.txt, then Enter
#   spikes/148/tmux.sh keys <vm> <keys…>
#   spikes/148/tmux.sh cap <vm>
#   spikes/148/tmux.sh kill <vm>
set -euo pipefail
cmd=$1
vm=$2
shift 2
config=/var/lib/claude-state/config

case "$cmd" in
start)
  dummy=$(cat "$1")
  shift
  envs=(-e "ANTHROPIC_BASE_URL=http://host.microsandbox.internal:18142"
    -e "CLAUDE_CODE_OAUTH_TOKEN=${dummy}"
    -e "CLAUDE_CONFIG_DIR=${config}"
    -e "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
    -e "DISABLE_AUTOUPDATER=1"
    -e "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1"
    -e "CLAUDE_CODE_SUBSCRIPTION_TYPE=max"
    -e "IS_SANDBOX=1"
    -e "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
    -e "SPIKE148_LOG_URL=http://host.microsandbox.internal:18148"
    -e "HOME=/root" -e "TERM=xterm-256color" -e "LANG=C.UTF-8")
  # Extra NAME=value lines for one run, e.g. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1.
  if [[ -f /tmp/spike148/extra-env ]]; then
    while IFS= read -r line; do [[ -n $line ]] && envs+=(-e "$line"); done </tmp/spike148/extra-env
  fi
  msb exec "$vm" -- sh -c "test -f $config/.claude.json || printf '%s' '{\"hasCompletedOnboarding\":true,\"theme\":\"dark\",\"bypassPermissionsModeAccepted\":true,\"projects\":{\"/workspace\":{\"hasTrustDialogAccepted\":true}}}' > $config/.claude.json"
  msb exec "$vm" -- tmux new-session -d -s claude -x 160 -y 50 -c /workspace "${envs[@]}" \
    /opt/claude-code/claude --plugin-dir /opt/spike148/probe --plugin-dir /opt/spike148/control \
    --dangerously-skip-permissions \
    --settings '{"teammateMode":"in-process"}' "$@" \; set-option -t claude remain-on-exit on
  ;;
text)
  msb exec "$vm" -- tmux send-keys -t claude -l "$1"
  sleep 0.5
  msb exec "$vm" -- tmux send-keys -t claude Enter
  ;;
prompt)
  # Types the prompt in spikes/148/prompts/<name>.txt, then Enter.
  msb exec "$vm" -- tmux send-keys -t claude -l "$(cat "$(dirname "$0")/prompts/$1.txt")"
  sleep 0.5
  msb exec "$vm" -- tmux send-keys -t claude Enter
  ;;
keys) msb exec "$vm" -- tmux send-keys -t claude "$@" ;;
cap) msb exec "$vm" -- tmux capture-pane -p -t claude ;;
kill) msb exec "$vm" -- tmux kill-server || true ;;
*)
  echo "usage: tmux.sh start|text|keys|cap|kill <vm> …" >&2
  exit 2
  ;;
esac
