#!/bin/sh
# A minimal stdio MCP server with one tool, `ping`, answering from the machine it runs on.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  case "$line" in
    *'"initialize"'*)
      v=$(printf '%s' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"e2e","version":"1.0.0"}}}\n' "$id" "$v"
      ;;
    *'"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"ping","description":"Answers pong, naming the machine it runs on","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id"
      ;;
    *'"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong from %s (%s %s)"}]}}\n' "$id" "$(hostname)" "$(uname -s)" "$(uname -m)"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      ;;
  esac
done
