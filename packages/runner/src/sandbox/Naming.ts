// How Sandboxes and volumes are named and labelled. Everything a backend makes starts with
// `claude-hub-` and carries its Session's id, so the Runner can find what it made after a crash
// (Reconcile.ts) and never mistakes anything else on the host for its own.
//
//   Sandbox: claude-hub-<sessionId>
//   Volume:  claude-hub-<sessionId>.<key>
//
// Several Runners can share one host, and so one microsandbox (#38). Each labels what it makes
// with its Runner mark (`claude-hub.runner`), and reconciles only what carries its own mark.
// Sandboxes made before the mark have none: they belong to no Runner, and are only reported.

import { createHash } from "node:crypto"
import type { SessionId } from "@claude-hub/protocol"
import { Effect } from "effect"
import { InvalidSandboxSpec } from "./SandboxBackend.ts"

export const prefix = "claude-hub-"

/** The label naming a Sandbox's or volume's Session. */
export const sessionLabel = "claude-hub.session"
/** The label naming a volume's key within its Session. */
export const volumeLabel = "claude-hub.volume"
/** The label carrying the mark of the Runner that made a Sandbox or volume. */
export const runnerLabel = "claude-hub.runner"

/**
 * This Runner's mark: a digest of its tmux socket name and sessions root. Both are fixed by its
 * configuration, so the mark survives restarts and is known before the Hub's welcome. They are
 * also exactly what decides which Sessions the Runner re-adopts: two Runners sharing both would
 * share their tmux sessions and directories too, so can't be told apart anyway, while Runners
 * that differ in either never adopt each other's Sessions. The Hub's RunnerId would do as well
 * once welcomed, but reconciling happens before connecting, and a Runner keeps its Sessions
 * across a new token.
 */
export const runnerMark = (runner: {
  readonly tmuxSocket: string
  readonly sessionsRoot: string
}) =>
  createHash("sha256")
    .update(`${runner.tmuxSocket}\0${runner.sessionsRoot}`)
    .digest("hex")
    .slice(0, 16)

// The backend's names are limited to 128 bytes; keep room for the prefix and a volume key.
const sessionIdPattern = /^[A-Za-z0-9_-]{1,80}$/
const volumeKeyPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/

export const isNameableSessionId = (sessionId: string) => sessionIdPattern.test(sessionId)

export const isVolumeKey = (key: string) => volumeKeyPattern.test(key)

/** Fails unless the Session id can name a Sandbox and its volumes. */
export const checkSessionId = (sessionId: SessionId) =>
  isNameableSessionId(sessionId)
    ? Effect.void
    : Effect.fail(
        new InvalidSandboxSpec({
          message: `Session id ${JSON.stringify(sessionId)} can't name a Sandbox: use up to 80 letters, digits, _ and -`,
        }),
      )

export const sandboxName = (sessionId: SessionId) => `${prefix}${sessionId}`

export const volumeName = (sessionId: SessionId, key: string) => `${prefix}${sessionId}.${key}`

/** The Session a Sandbox name belongs to, if it is one of ours. */
export const parseSandboxName = (name: string): SessionId | undefined => {
  if (!name.startsWith(prefix)) return undefined
  const sessionId = name.slice(prefix.length)
  return isNameableSessionId(sessionId) ? (sessionId as SessionId) : undefined
}

/** The Session and key a volume name belongs to, if it is one of ours. */
export const parseVolumeName = (
  name: string,
): { readonly sessionId: SessionId; readonly key: string } | undefined => {
  if (!name.startsWith(prefix)) return undefined
  const rest = name.slice(prefix.length)
  const dot = rest.indexOf(".")
  if (dot < 0) return undefined
  const sessionId = rest.slice(0, dot)
  const key = rest.slice(dot + 1)
  return isNameableSessionId(sessionId) && isVolumeKey(key)
    ? { sessionId: sessionId as SessionId, key }
    : undefined
}
