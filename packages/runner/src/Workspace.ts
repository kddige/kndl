import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { SessionId, StartSession } from "@claude-hub/protocol"
import { Context, Data, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  claudeConfigPath,
  claudeProjectDirName,
  claudeProjectsDir,
  forgetDirectories,
} from "./ClaudeConfig.ts"
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
 * Archiving keeps the Workspace, so a restored Session wakes on it; purging removes it.
 *
 * Still to come here: restoring a Workspace from its WIP ref when the Runner lost it.
 */
export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * Creates the Session's directories. A new Session's Workspace is cloned onto its Work branch;
     * a waking one (`resume`) must already have its Workspace.
     */
    readonly prepare: (start: StartSession) => Effect.Effect<SessionDirectories, WorkspaceError>
    /**
     * Deletes everything of a purged Session on the host: its directory, with the Workspace and
     * the Runner's git directory for it, and what Claude Code keeps of the directory it ran in.
     * Succeeds when nothing is left.
     */
    readonly remove: (sessionId: SessionId) => Effect.Effect<void, WorkspaceError>
  }
>()("@claude-hub/runner/Workspaces") {}

const fileError = (error: { readonly message: string }) =>
  new WorkspaceError({ message: error.message })

/** Makes every directory under `path` writable by its owner, without following symlinks. */
function makeWritable(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory()) return
  chmodSync(path, (stat.mode & 0o7777) | 0o700)
  for (const entry of readdirSync(path)) makeWritable(join(path, entry))
}

/** Where Claude Code keeps its state: its transcripts directory and its config file. */
export interface ClaudeState {
  readonly projectsDir: string
  readonly configPath: string
}

/**
 * Deletes a Session's directory and what Claude Code keeps of the directory it ran in: its
 * transcripts under `projects`, and its entry in the config file. The Sandbox may have left
 * directories it can't be written to, so those are made writable first. Symlinks are removed,
 * never followed.
 */
export const removeSessionFiles = (
  directories: SessionDirectories,
  claude: ClaudeState = { projectsDir: claudeProjectsDir(), configPath: claudeConfigPath() },
) =>
  Effect.gen(function* () {
    // Claude Code knows the directory it ran in by its real path, as on macOS's /private/var.
    const cwds = yield* Effect.try({
      try: () => [
        ...new Set([
          directories.claude,
          ...(existsSync(directories.claude) ? [realpathSync(directories.claude)] : []),
        ]),
      ],
      catch: (cause) => new WorkspaceError({ message: String(cause) }),
    })
    yield* forgetDirectories(claude.configPath, cwds).pipe(
      Effect.mapError((error) => new WorkspaceError({ message: error.message })),
    )
    yield* Effect.try({
      try: () => {
        for (const cwd of cwds) {
          const name = claudeProjectDirName(cwd)
          if (name !== undefined) {
            rmSync(join(claude.projectsDir, name), { recursive: true, force: true })
          }
        }
        try {
          rmSync(directories.session, { recursive: true, force: true })
        } catch {
          makeWritable(directories.session)
          rmSync(directories.session, { recursive: true, force: true })
        }
      },
      catch: (cause) =>
        new WorkspaceError({
          message: `Could not delete ${directories.session}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
  })

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
            .makeDirectory(directories.session, { recursive: true })
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
      remove: (sessionId) => removeSessionFiles(sessionDirectories(config.sessionsRoot, sessionId)),
    })
  }),
)
