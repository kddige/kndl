#!/usr/bin/env bash
# Type-checks the mod against the installed Claude Code's plugin API.
#
# Claude Code lays the API's declarations in .claude-plugin/types/ each time it loads the mod;
# there is no command that only writes them. Loading the mod in a print-mode session that runs
# the local /cost command lays them without a model call.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v claude >/dev/null; then
  cat >&2 <<'MSG'
hub-link's typecheck needs Claude Code (claude) on PATH: it loads the mod into Claude Code,
which writes the plugin API's types the mod is checked against. Install Claude Code with
  curl -fsSL https://claude.ai/install.sh | bash
(or see https://docs.anthropic.com/en/docs/claude-code), then run this again.
MSG
  exit 1
fi

bun run build >/dev/null
claude --plugin-dir . --strict-mcp-config -p /cost >/dev/null
# The mod itself, against the mod runtime only; then its Bun unit tests, against Bun.
tsc --noEmit -p .
tsc --noEmit -p tsconfig.spec.json
