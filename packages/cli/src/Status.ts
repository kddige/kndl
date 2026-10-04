// `claude-hub status`: what's installed in the home, which services run, where the Hub is, whether
// the Runner is connected, and which commit the install is on.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { Console, Effect } from "effect"
import { InstallLine, RoleTitle } from "./Actions.ts"
import {
  configuredRoles,
  health,
  hubLocalUrl,
  isInstalled,
  platform,
  readCheckout,
  readEnvValues,
  serviceState,
  serviceTarget,
} from "./Host.ts"
import type { Layout } from "./Layout.ts"
import { describeConnection, runnerConnection } from "./RunnerLog.ts"
import { describeServiceState } from "./Services.ts"
import { Shell } from "./Shell.ts"
import { describeCheckout } from "./Update.ts"

/** How much of the Runner's log `status` reads for its connection: the end of it. */
const LogTail = 64 * 1024

/** How long the Runner's log is now: what it says after this is from a later start. */
export function runnerLogSize(layout: Layout): number {
  const path = layout.logFile("runner")
  return existsSync(path) ? statSync(path).size : 0
}

/** What the Runner's log last said about its connection, after byte `since`. */
export function readRunnerConnection(layout: Layout, since = 0) {
  const path = layout.logFile("runner")
  if (!existsSync(path)) return describeConnection({ _tag: "Unknown" })
  return describeConnection(runnerConnection(readTail(path, LogTail, since)))
}

/** The last `bytes` of a file after byte `since`; it may begin mid-line. */
function readTail(path: string, bytes: number, since: number): string {
  const size = statSync(path).size
  const start = Math.max(since, size - bytes, 0)
  const length = Math.max(size - start, 0)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, "r")
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  return buffer.toString("utf8")
}

/**
 * Waits up to `seconds` for the Runner's log to say, after byte `since`, that it connected, and
 * says how it stands.
 */
export const runnerConnectionAfter = (layout: Layout, since: number, seconds: number) =>
  Effect.gen(function* () {
    for (let waited = 0; ; waited += 1) {
      const said = readRunnerConnection(layout, since)
      if (said.startsWith("connected") || waited >= seconds) return said
      yield* Effect.sleep("1 second")
    }
  })

/** Prints the status; fails (exit 1) when there is no install. */
export const status = (layout: Layout) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    if (!isInstalled(layout)) {
      yield* Console.log(
        [
          `claude-hub is not installed in ${layout.home.dir}.`,
          "",
          `Install it with:  ${InstallLine}`,
          "or set CLAUDE_HUB_HOME to the home you installed.",
        ].join("\n"),
      )
      return false
    }
    const checkout = yield* readCheckout(layout.app)
    const lines = [`claude-hub in ${layout.home.dir}`, `  Install   ${describeCheckout(checkout)}`]
    const roles = configuredRoles(layout)
    if (roles.length === 0) {
      lines.push("  Setup     neither a Hub nor a Runner yet: run `claude-hub onboard`")
    }
    const on = platform()
    for (const role of roles) {
      const state =
        on === undefined
          ? "no services on this platform"
          : describeServiceState(yield* serviceState(serviceTarget(layout, role, on)))
      lines.push(`  ${RoleTitle[role].padEnd(8)}  service ${state}`)
      if (role === "hub") {
        const values = readEnvValues(layout.envFile("hub"))
        lines.push(`            public URL ${values.HUB_PUBLIC_URL ?? "(none set)"}`)
        const result = yield* health(hubLocalUrl(layout))
        lines.push(`            health ${result.ok ? "ok" : result.detail} (${result.url}/health)`)
      } else {
        const values = readEnvValues(layout.envFile("runner"))
        lines.push(
          `            ${values.RUNNER_NAME ? `named ${values.RUNNER_NAME}, ` : ""}Hub ${values.HUB_URL ?? "(none set)"}`,
        )
        lines.push(`            ${readRunnerConnection(layout)}`)
      }
    }
    if (shell.dryRun) lines.push("  (dry run: launchctl and systemctl weren't asked)")
    yield* Console.log(lines.join("\n"))
    return true
  })
