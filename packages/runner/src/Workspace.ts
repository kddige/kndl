import type { StartSession } from "@claude-hub/protocol"
import { Context, Data, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { cloneWorkspace } from "./HostGit.ts"
import { HubGit } from "./HubGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { type SessionDirectories, sessionDirectories } from "./SessionNames.ts"
import { askAccess } from "./WorkspaceGit.ts"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string
}> {}

/**
 * Lays out a Session's directories on the host before its Claude Code starts: the empty
 * directory Claude Code runs in, and the Workspace.
 *
 * Still to come here: restoring a Workspace from its WIP ref when the Runner lost it, and
 * cleaning up on archive.
 */
export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * Creates the Session's directories. A new Session's Workspace is cloned onto its Work branch;
     * a waking one (`resume`) must already have its Workspace.
     */
    readonly prepare: (start: StartSession) => Effect.Effect<SessionDirectories, WorkspaceError>
  }
>()("@claude-hub/runner/Workspaces") {}

const fileError = (error: { readonly message: string }) =>
  new WorkspaceError({ message: error.message })

/**
 * `git clone` the Repo on the host (ADR 0005), with the GitHub App token the Hub mints, or the
 * host's own git credentials when the Hub has no App (dev mode). Then create the Work branch from
 * the base branch. The token is passed to git for these commands only, never stored.
 */
export const WorkspacesGitClone = Layer.effect(
  Workspaces,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const hubGit = yield* HubGit

    const clone = (start: StartSession, workspace: string) =>
      Effect.gen(function* () {
        const access = yield* askAccess(hubGit, config.repoUrlTemplate, start.sessionId)
        yield* cloneWorkspace({
          url: config.repoUrlTemplate.replaceAll("{repo}", start.repo),
          auth: access.auth,
          workspace,
          baseBranch: start.baseBranch,
          workBranch: start.workBranch,
        })
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) => new WorkspaceError({ message: error.message })),
        Effect.onError(() =>
          fs.remove(workspace, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      )

    return Workspaces.of({
      prepare: (start) =>
        Effect.gen(function* () {
          const directories = sessionDirectories(config.sessionsRoot, start.sessionId)
          yield* fs
            .makeDirectory(directories.claude, { recursive: true })
            .pipe(Effect.mapError(fileError))
          const hasWorkspace = yield* fs
            .exists(`${directories.workspace}/.git`)
            .pipe(Effect.mapError(fileError))
          if (hasWorkspace) return directories
          if (start.resume !== undefined) {
            return yield* new WorkspaceError({
              message: `Session ${start.sessionId} has no Workspace at ${directories.workspace} to wake with`,
            })
          }
          yield* clone(start, directories.workspace)
          return directories
        }),
    })
  }),
)
