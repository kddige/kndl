// How Sandboxes, volumes and snapshots are named and labelled. Everything a backend makes starts
// with `claude-hub-` and carries its Session's id, so the Runner can find what it made after a
// crash (Reconcile.ts) and never mistakes anything else on the host for its own.
//
//   Sandbox:        claude-hub-<sessionId>
//   Volume:         claude-hub-<sessionId>.<key>
//   Snapshot group: claude-hub-<runner mark>-<group>
//
// Environment builds and Test builds run in Sandboxes of their own (ADR 0009), addressed like a
// Session's by an id no Hub-minted Session id can take: `build-…` or `testbuild-…`.
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
 * also exactly what decides which Sessions are the Runner's own: two Runners sharing both would
 * share their Session directories too, so can't be told apart anyway, while Runners that differ
 * in either never reconcile each other's Sandboxes. The Hub's RunnerId would do as well
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

/**
 * The names a backend gives what it makes, under `namePrefix`: {@link prefix} for a Runner, and
 * something else only for tests that must keep apart from a Runner's Sandboxes on the same host.
 */
export const namesFor = (namePrefix: string) => ({
  prefix: namePrefix,
  sandboxName: (sessionId: SessionId) => `${namePrefix}${sessionId}`,
  volumeName: (sessionId: SessionId, key: string) => `${namePrefix}${sessionId}.${key}`,
  /** The backend's name for a Runner's snapshot group. */
  snapshotGroup: (runner: string, group: string) => `${namePrefix}${runner}-${group}`,
  /** The Session a Sandbox name belongs to, if it is one of ours. */
  parseSandboxName: (name: string): SessionId | undefined => {
    if (!name.startsWith(namePrefix)) return undefined
    const sessionId = name.slice(namePrefix.length)
    return isNameableSessionId(sessionId) ? (sessionId as SessionId) : undefined
  },
  /** The Session and key a volume name belongs to, if it is one of ours. */
  parseVolumeName: (
    name: string,
  ): { readonly sessionId: SessionId; readonly key: string } | undefined => {
    if (!name.startsWith(namePrefix)) return undefined
    const rest = name.slice(namePrefix.length)
    const dot = rest.indexOf(".")
    if (dot < 0) return undefined
    const sessionId = rest.slice(0, dot)
    const key = rest.slice(dot + 1)
    return isNameableSessionId(sessionId) && isVolumeKey(key)
      ? { sessionId: sessionId as SessionId, key }
      : undefined
  },
})

export type Names = ReturnType<typeof namesFor>

export const { sandboxName, volumeName, parseSandboxName, parseVolumeName } = namesFor(prefix)

/** A snapshot group's name: lowercase letters, digits and `-`. */
export const isSnapshotGroup = (group: string) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(group)

/** A snapshot's name within its group: letters, digits, `_` and `-`. */
export const isSnapshotName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

/** The Sandbox an Environment build runs in: one per build key at a time. */
export const buildSandboxId = (key: string) => `build-${digest(key)}` as SessionId

/** The Sandbox a Test build runs in. */
export const testBuildSandboxId = (testBuildId: string) =>
  `testbuild-${digest(testBuildId)}` as SessionId

/** Whether a Sandbox is a build's or a Test build's, thrown away when done, rather than a Session's. */
export const isBuildSandboxId = (sessionId: string) => /^(test)?build-[0-9a-f]{16}$/.test(sessionId)
