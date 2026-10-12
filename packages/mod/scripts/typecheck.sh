#!/usr/bin/env bash
# Type-checks the mod's two plugins against the installed Claude Code's plugin API.
#
# Claude Code lays the API's declarations in each plugin's .claude-plugin/types/ each time it
# loads the plugin; there is no command that only writes them. Loading both in a print-mode
# session that runs the local /cost command lays them without a model call or a sign-in, but only
# with CLAUDE_CODE_PLUGIN_DIR_WATCH=1: a plain `claude -p` loads plugins fresh and lays nothing, so
# a checkout no interactive session has loaded the mod in (CI's) would have no types.
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
# Run inside a kndl Session, the mod it loads would otherwise link to the Session's Hub as this
# claude, whose conversation the Session would then wake into (#321).
env -u KNDL_URL -u KNDL_SESSION_ID -u KNDL_MOD_TOKEN -u KNDL_CONVERSATION_ID \
  CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --plugin-dir plugins/hub-link \
  --plugin-dir plugins/hub-link-commands --strict-mcp-config -p /cost >/dev/null
# Each plugin, against the mod runtime only; then the Bun unit tests, against Bun.
tsc --noEmit -p plugins/hub-link
tsc --noEmit -p plugins/hub-link-commands
tsc --noEmit -p tsconfig.spec.json
