// Claude Code's process, spawned by the bridge rather than the Agent SDK, so the bridge knows
// when it has exited. A query's close() only asks Claude Code to stop: it goes on for up to a
// second or so, writing the end of the stopped turn into its session file ("[Request interrupted
// by user]"), and the SDK kills it only after a grace period. The session file can be cut back
// after an abort (SessionMirror.ts) only once nothing writes to it any more.

import { spawn } from "node:child_process"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"

/** Longer than the SDK's own escalation (2 s grace, then SIGTERM, then SIGKILL 5 s on). */
export const ExitTimeoutMs = 10_000

/** How much of Claude Code's stderr a failure carries, as the SDK's own spawn keeps. */
const StderrTailChars = 2_000

export interface ProcessWatch {
  /** Spawns Claude Code as the SDK would: its `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess
  /** Whether a process was spawned: one closed before it was has nothing to wait for. */
  readonly spawned: () => boolean
  /**
   * Settles true once the process has exited, or when it never started; false when it's still
   * running after `timeoutMs`.
   */
  readonly exited: (timeoutMs?: number) => Promise<boolean>
  /** A failure's message with the end of Claude Code's stderr, which the SDK can't see. */
  readonly withStderr: (message: string) => string
}

/** A watch for one query's Claude Code; `onStderr` gets its stderr as it comes. */
export function watchProcess(onStderr?: (text: string) => void): ProcessWatch {
  let exit: Promise<void> | undefined
  let stderrTail = ""
  return {
    spawn: (options) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      exit = new Promise<void>((resolve) => {
        child.once("exit", () => resolve())
        // A process that never started never writes.
        child.once("error", () => {
          if (child.pid === undefined) resolve()
        })
      })
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (text: string) => {
        stderrTail = (stderrTail + text).slice(-StderrTailChars)
        onStderr?.(text)
      })
      // Errors are the exit's or the spawn's, which the SDK hears of on the process.
      child.stderr.on("error", () => {})
      return child
    },
    spawned: () => exit !== undefined,
    exited: (timeoutMs = ExitTimeoutMs) => {
      if (exit === undefined) return Promise.resolve(true)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      return Promise.race([exit.then(() => true), timeout]).finally(() => clearTimeout(timer))
    },
    withStderr: (message) => {
      const tail = stderrTail.trim()
      if (!tail || message.includes("stderr:")) return message
      if (!/^Claude Code process (exited|terminated)/.test(message)) return message
      return `${message}. stderr: ${tail}`
    },
  }
}
