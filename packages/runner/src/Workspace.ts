import type { StartSession } from "@claude-hub/protocol"
import { Context, Data, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { runCommand } from "./Process.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { type SessionDirectories, sessionDirectories } from "./SessionNames.ts"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string
}> {}

/**
 * Lays out a Session's directories on the host before its Claude Code starts: the empty
 * directory Claude Code runs in, and the Workspace.
 *
 * This is the seam the Session lifecycle (#12) and the host git tools (#13) take over: cloning
 * with a GitHub App token, restoring from the WIP ref, and cleaning up on archive.
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
 * Dev mode: `git clone` the Repo with the host's own git credentials (ADR 0005 puts git on the
 * host), then create the Work branch from the base branch.
 */
export const WorkspacesGitClone = Layer.effect(
  Workspaces,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const git = (args: ReadonlyArray<string>) =>
      runCommand("git", args).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) => new WorkspaceError({ message: error.message })),
      )

    const clone = (start: StartSession, workspace: string) =>
      Effect.gen(function* () {
        const url = config.repoUrlTemplate.replaceAll("{repo}", start.repo)
        yield* git(["clone", "--branch", start.baseBranch, "--", url, workspace])
        yield* git(["-C", workspace, "switch", "--create", start.workBranch])
      }).pipe(
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
