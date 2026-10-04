// The WIP ref (issue #13, ADR 0010): the Runner, on its host, force-pushes a snapshot of a
// Session's Workspace to `refs/claude-hub/wip/<session>` after a Turn that changed it, and before
// the Session sleeps or is archived. A failure is logged and reported to the Hub, and never stops
// anything else. One WIP push runs at a time per Session. The token for it stays with the
// Runner, which asks the Hub for one per push.

import { join } from "node:path"
import { type GitIdentity, type SessionId, wipRef } from "@claude-hub/protocol"
import { Cause, Context, Duration, Effect, Layer, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  commitSnapshot,
  forcePushRef,
  type GitAuth,
  GitError,
  snapshotTree,
  WipIdentity,
  type WorkspacePaths,
} from "./HostGit.ts"
import { HubGit } from "./HubGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import type { SessionDirectories } from "./SessionNames.ts"

/** Why a WIP push runs. */
export type WipReason = "TurnEnded" | "Sleep" | "Archive"

/** How long a WIP push may hold up whatever comes after it, such as the Sandbox stopping. */
export const WipPushTimeout = Duration.minutes(2)

export class WorkspaceGit extends Context.Service<
  WorkspaceGit,
  {
    /**
     * Pushes the Workspace's state to its WIP ref, unless nothing changed since the last WIP
     * push. Never fails: a failure is logged and reported to the Hub.
     */
    readonly pushWip: (
      sessionId: SessionId,
      directories: SessionDirectories,
      reason: WipReason,
    ) => Effect.Effect<void>
  }
>()("@claude-hub/runner/WorkspaceGit") {}

/** The Repo access a GitAccess answer gave. */
export interface RepoAccess {
  readonly url: string
  readonly auth: GitAuth
  /** The App's bot, when there is one; commits are authored by the host's identity otherwise. */
  readonly author: GitIdentity | undefined
}

/**
 * Asks the Hub how to reach the Session's Repo: the URL the Runner pushes to (from RUNNER_REPO_URL,
 * never the Workspace's own config), and a token or the host's credentials.
 */
export const askAccess = (
  hubGit: HubGit["Service"],
  repoUrlTemplate: string,
  sessionId: SessionId,
) =>
  Effect.gen(function* () {
    const answer = yield* hubGit.ask(sessionId, { _tag: "GitAccess" })
    if (answer._tag === "GitFailed") return yield* new GitError({ message: answer.message })
    if (answer._tag !== "GitAccess")
      return yield* new GitError({ message: "the Hub gave no Repo access" })
    const credentials = answer.credentials
    return {
      url: repoUrlTemplate.replaceAll("{repo}", answer.repo),
      auth:
        credentials._tag === "AppToken"
          ? { _tag: "Token", token: credentials.token }
          : { _tag: "Host" },
      author: credentials._tag === "AppToken" ? credentials.author : undefined,
    } satisfies RepoAccess
  })

const paths = (directories: SessionDirectories): WorkspacePaths => ({
  workspace: directories.workspace,
  hostGit: directories.hostGit,
})

/** The tree and parent of the last WIP snapshot pushed, kept in the Runner's git dir. */
const lastPushedFile = (directories: SessionDirectories) => join(directories.hostGit, "wip-pushed")

export const WorkspaceGitLive = Layer.effect(
  WorkspaceGit,
  Effect.gen(function* () {
    const hubGit = yield* HubGit
    const config = yield* RunnerConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const locks = new Map<SessionId, Semaphore.Semaphore>()
    const serialized =
      (sessionId: SessionId) =>
      <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) => {
        let lock = locks.get(sessionId)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(sessionId, lock)
        }
        return lock
          .withPermit(effect)
          .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      }

    const access = (sessionId: SessionId) => askAccess(hubGit, config.repoUrlTemplate, sessionId)

    const pushWipNow = (sessionId: SessionId, directories: SessionDirectories, reason: WipReason) =>
      Effect.gen(function* () {
        const hasWorkspace = yield* Effect.promise(() =>
          Bun.file(join(directories.workspace, ".git", "HEAD")).exists(),
        )
        if (!hasWorkspace) return
        const snapshot = yield* snapshotTree(paths(directories))
        const state = `${snapshot.tree} ${snapshot.parent}`
        const last = yield* Effect.promise(() =>
          Bun.file(lastPushedFile(directories))
            .text()
            .catch(() => ""),
        )
        if (last.trim() === state) return
        const repo = yield* access(sessionId)
        const commit = yield* commitSnapshot(paths(directories), snapshot, {
          message: `claude-hub WIP of Session ${sessionId} (${reason})`,
          identity: repo.author ?? WipIdentity,
        })
        yield* forcePushRef(paths(directories), {
          url: repo.url,
          auth: repo.auth,
          commit,
          ref: wipRef(sessionId),
        })
        yield* Effect.promise(() => Bun.write(lastPushedFile(directories), `${state}\n`))
        yield* Effect.logInfo(`Session ${sessionId}: pushed its WIP ref (${reason})`)
      })

    const pushWip = (sessionId: SessionId, directories: SessionDirectories, reason: WipReason) =>
      serialized(sessionId)(pushWipNow(sessionId, directories, reason)).pipe(
        Effect.timeoutOrElse({
          duration: WipPushTimeout,
          orElse: () => Effect.fail(new GitError({ message: "the push took too long" })),
        }),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          const message = `Could not push the WIP ref (${reason}): ${error instanceof Error ? error.message : String(error)}`
          return Effect.logWarning(`Session ${sessionId}: ${message}`).pipe(
            Effect.andThen(hubGit.wipPushFailed(sessionId, message)),
          )
        }),
      )

    return WorkspaceGit.of({ pushWip })
  }),
)
