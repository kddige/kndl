#!/usr/bin/env bash
# Spike #142: what the credential proxy adds. From inside a Sandbox, times GET /v1/models through the
# proxy (curl's time to first byte) and prints it beside the proxy's own time to the upstream's
# headers (x-spike-upstream-headers-ms). The difference is the guest-to-host hop plus the proxy.
#
#   spikes/142/latency.sh <vm> <dummy-file> [runs, default 10]
set -euo pipefail
vm=$1
dummy=$(cat "$2")
runs=${3:-10}
port=${SPIKE142_PORT:-18142}
msb exec "$vm" -e "DUMMY=$dummy" -e "RUNS=$runs" -e "PORT=$port" -- sh -c '
  for i in $(seq "$RUNS"); do
    curl -s -o /dev/null -D /tmp/h -w "%{http_code} %{time_starttransfer}\n" \
      -H "authorization: Bearer $DUMMY" -H "anthropic-version: 2023-06-01" \
      -H "anthropic-beta: oauth-2025-04-20" \
      "http://host.microsandbox.internal:$PORT/v1/models" |
      { read -r code ttfb; up=$(grep -i x-spike-upstream-headers-ms /tmp/h | tr -d "\r" | cut -d" " -f2)
        echo "status=$code guest_ttfb_ms=$(awk "BEGIN{print int($ttfb*1000)}") upstream_ms=$up"; }
  done'
