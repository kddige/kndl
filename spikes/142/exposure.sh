#!/usr/bin/env bash
# Spike #142: what the credential proxy refuses, probed from inside a Sandbox. Prints one status line
# per probe; nothing is printed from the response bodies but their error message.
#
#   spikes/142/exposure.sh <vm> <dummy-file>
set -euo pipefail
vm=$1
dummy=$(cat "$2")
port=${SPIKE142_PORT:-18142}
msb exec "$vm" -e "DUMMY=$dummy" -e "PORT=$port" -- sh -c '
  base=http://host.microsandbox.internal:$PORT
  probe() {
    label=$1; shift
    out=$(curl -s -w " %{http_code}" "$@")
    echo "$label -> ${out##* } $(echo "${out% *}" | grep -o "\"message\":\"[^\"]*\"" || true)"
  }
  h="-H anthropic-version:2023-06-01 -H anthropic-beta:oauth-2025-04-20"
  probe "no credential, GET /v1/models" $h "$base/v1/models"
  probe "wrong credential, GET /v1/models" $h -H "authorization: Bearer chs_not_a_session" "$base/v1/models"
  probe "x-api-key with the dummy" $h -H "x-api-key: $DUMMY" -o /dev/null "$base/v1/models"
  probe "dummy, GET /v1/models (allowed)" $h -H "authorization: Bearer $DUMMY" -o /dev/null "$base/v1/models"
  probe "dummy, GET /api/oauth/profile" $h -H "authorization: Bearer $DUMMY" "$base/api/oauth/profile"
  probe "dummy, GET /api/oauth/usage" $h -H "authorization: Bearer $DUMMY" "$base/api/oauth/usage"
  probe "dummy, POST /v1/oauth/token" $h -H "authorization: Bearer $DUMMY" -X POST "$base/v1/oauth/token"
  probe "dummy, GET /v1/files" $h -H "authorization: Bearer $DUMMY" "$base/v1/files"
  probe "dummy, path traversal" $h -H "authorization: Bearer $DUMMY" --path-as-is "$base/v1/messages/../models"
  probe "dummy, GET /v1/messages" $h -H "authorization: Bearer $DUMMY" "$base/v1/messages"
  probe "no credential, HEAD /api/hello" -I "$base/api/hello" -o /dev/null
'
