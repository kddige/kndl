#!/usr/bin/env bash
# Spike #142: Claude Code in tmux *inside* a spike Sandbox, driven from the host with msb exec.
#
#   spikes/142/tmux.sh start <vm> <dummy-file> [claude args…]   # new tmux session "claude"
#   spikes/142/tmux.sh keys <vm> <tmux send-keys args…>         # e.g. keys vm "hello" Enter
#   spikes/142/tmux.sh text <vm> <text>                         # types literal text, then Enter
#   spikes/142/tmux.sh cap <vm>                                 # prints the screen
#   spikes/142/tmux.sh wait <vm> <regex> [timeout s]            # waits for the screen to match
#   spikes/142/tmux.sh kill <vm>
#
# Claude Code gets the proxy's base URL and the Session's dummy token through `tmux new-session
# -e`, so they live only in that process's environment. SPIKE142_ENV adds more
# (newline-separated KEY=VALUE lines), as does the file named by SPIKE142_ENV_FILE.
set -euo pipefail
cmd=$1
vm=$2
shift 2
port=${SPIKE142_PORT:-18142}
config=/var/lib/claude-state/config

case "$cmd" in
start)
  dummy=$(cat "$1")
  shift
  envs=(-e "ANTHROPIC_BASE_URL=http://host.microsandbox.internal:${port}"
    -e "CLAUDE_CODE_OAUTH_TOKEN=${dummy}"
    -e "CLAUDE_CONFIG_DIR=${config}"
    -e "HOME=/root" -e "TERM=xterm-256color" -e "LANG=C.UTF-8")
  extra=${SPIKE142_ENV:-}
  [[ -n ${SPIKE142_ENV_FILE:-} ]] && extra+=$'\n'$(cat "$SPIKE142_ENV_FILE")
  while IFS= read -r kv; do [[ -n $kv ]] && envs+=(-e "$kv"); done <<<"$extra"
  # Skip the first-run screens and the folder-trust dialog, as the Runner does on the host.
  msb exec "$vm" -- sh -c "test -f $config/.claude.json || printf '%s' '{\"hasCompletedOnboarding\":true,\"theme\":\"dark\",\"projects\":{\"/workspace\":{\"hasTrustDialogAccepted\":true}}}' > $config/.claude.json"
  # remain-on-exit keeps the pane, and Claude Code's last words, if it exits.
  msb exec "$vm" -- tmux new-session -d -s claude -x 150 -y 45 -c /workspace "${envs[@]}" \
    /opt/claude-code/claude "$@" \; set-option -t claude remain-on-exit on
  ;;
keys) msb exec "$vm" -- tmux send-keys -t claude "$@" ;;
text)
  msb exec "$vm" -- tmux send-keys -t claude -l "$1"
  sleep 0.3
  msb exec "$vm" -- tmux send-keys -t claude Enter
  ;;
prompt)
  # Types the prompt in spikes/142/prompts/<name>.txt, then Enter.
  msb exec "$vm" -- tmux send-keys -t claude -l "$(cat "$(dirname "$0")/prompts/$1.txt")"
  sleep 0.3
  msb exec "$vm" -- tmux send-keys -t claude Enter
  ;;
cap) msb exec "$vm" -- tmux capture-pane -p -t claude ;;
wait)
  deadline=$((SECONDS + ${2:-60}))
  until msb exec "$vm" -- tmux capture-pane -p -t claude | grep -Eq "$1"; do
    if ((SECONDS > deadline)); then
      echo "timed out waiting for /$1/" >&2
      exit 1
    fi
    sleep 0.5
  done
  ;;
kill) msb exec "$vm" -- tmux kill-server || true ;;
*)
  echo "usage: tmux.sh start|keys|text|cap|wait|kill <vm> …" >&2
  exit 2
  ;;
esac
