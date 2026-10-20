// The durable agent's process (docs/design/durable-harness.md, "The process"): the Runner starts
// it in the Sandbox with the pinned Node.js, `node /opt/kndl/mod/<copy>/durable/agent.js`, in a
// tmux session of its own. It reads the Runner's environment, opens the Session's storage on its
// persistent volume, and runs until the Runner stops it.
//
// - SIGTERM, SIGINT or SIGHUP: it flushes what the Hub hasn't heard, closes the Harness cleanly (a
//   run in progress stays in storage and resumes at the next start) and exits 0. Should that take
//   longer than ShutdownDeadlineMs it exits anyway, as the Runner kills it once its grace period
//   is over, and a second agent must not open the storage beside one still closing it.
// - A storage failure ends the Harness (`closed` with `failed`): it exits 1, and the Runner sees
//   the agent's tmux session exit and reports the Harness stopped.
//
// Its log is `$KNDL_STATE_DIR/durable/agent.log`, with the mod token and the Claude token
// redacted, and it is printed to stderr as well, so the Runner reads why the agent exited from its
// tmux pane. Both tokens, and tmux's own variables, are taken out of its environment as it starts,
// so no command the agent runs inherits them. That is inheritance hygiene only: it doesn't change
// what /proc/<pid>/environ shows of the process itself, which anyone who can read it can still see.

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { ThinkingLevel } from "@kndl/protocol"
import { Schema } from "effect"
import { startDurableAgent } from "./DurableAgent.ts"
import { McpServersVariable, mcpServerSpecs } from "./Mcp.ts"
import { gatewayCatalog } from "./Providers.ts"
import { redact } from "./Turns.ts"

const env = process.env
const { KNDL_URL, KNDL_MOD_TOKEN, KNDL_SESSION_ID } = env
const stateDir = join(env.KNDL_STATE_DIR || "/var/lib/kndl/claude", "durable")
mkdirSync(stateDir, { recursive: true })

const secrets = [KNDL_MOD_TOKEN ?? "", env.CLAUDE_CODE_OAUTH_TOKEN ?? ""].filter(
  (secret) => secret.length >= 8,
)
const logFile = join(stateDir, "agent.log")
// Its pane may be closed under it (a hangup), which makes a write to the terminal fail.
process.stderr.on("error", () => {})
const log = (text: string) => {
  const line = `${new Date().toISOString()} ${redact(text, secrets)}\n`
  try {
    appendFileSync(logFile, line)
  } catch {}
  process.stderr.write(line)
}

if (!KNDL_URL || !KNDL_MOD_TOKEN || !KNDL_SESSION_ID) {
  log("kndl: KNDL_URL, KNDL_MOD_TOKEN and KNDL_SESSION_ID are needed: not started by a Runner?")
  process.exit(2)
}

// The agent's commands inherit its environment: the tokens stay with the agent alone, and so does
// the way back to its tmux server, which a plain `tmux` run by a command would act on through
// TMUX. The Claude bridge is handed its token, and runs Claude Code with it.
delete process.env.TMUX
delete process.env.TMUX_PANE
const bridgeEnv = { ...env }
delete process.env.KNDL_MOD_TOKEN
delete process.env.CLAUDE_CODE_OAUTH_TOKEN

const thinking = env.KNDL_THINKING
const thinkingLevel =
  thinking !== undefined && Schema.is(ThinkingLevel)(thinking) ? thinking : undefined
const cwd = env.KNDL_WORKSPACE || (process.cwd() === "/" ? "/workspace" : process.cwd())

log(`kndl: starting the durable agent for Session ${KNDL_SESSION_ID} in ${cwd}`)

const agent = await startDurableAgent({
  hubUrl: KNDL_URL,
  modToken: KNDL_MOD_TOKEN,
  sessionId: KNDL_SESSION_ID,
  conversationId: env.KNDL_CONVERSATION_ID || undefined,
  model: env.KNDL_MODEL || undefined,
  thinkingLevel,
  mcpServers: mcpServerSpecs(env[McpServersVariable], log),
  cwd,
  storage: await openNodeSqliteStorage(join(stateDir, "session.sqlite")),
  catalog: (fetch) =>
    gatewayCatalog({ hubUrl: KNDL_URL, modToken: KNDL_MOD_TOKEN, fetch, env: bridgeEnv, cwd, log }),
  log,
  secrets,
}).catch((error: unknown) => {
  log(`kndl: the durable agent couldn't start: ${error instanceof Error ? error.stack : error}`)
  process.exit(1)
})

log(`kndl: linked as conversation ${agent.conversationId}`)

// Below the Runner's StopGracePeriod (Sessions.ts), 10 seconds from its SIGTERM.
const ShutdownDeadlineMs = 8_000

let stopping = false
const stop = (signal: string) => {
  if (stopping) return
  stopping = true
  log(`kndl: ${signal}: shutting down`)
  setTimeout(() => {
    log(`kndl: shutting down took over ${ShutdownDeadlineMs / 1000} seconds: exiting`)
    process.exit(1)
  }, ShutdownDeadlineMs).unref()
  void agent.shutdown().finally(() => process.exit(0))
}
process.on("SIGTERM", () => stop("SIGTERM"))
process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGHUP", () => stop("SIGHUP"))
process.on("unhandledRejection", (error) => log(`kndl: unhandled: ${String(error)}`))

void agent.closed.then((end) => {
  if (end.reason !== "failed") return
  log(`kndl: the Session's storage failed: ${String(end.error)}`)
  process.exit(1)
})
