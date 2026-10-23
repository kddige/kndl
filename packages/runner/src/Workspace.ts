import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { HearthBranch, isHearthRepo, type SessionId, type StartSession } from "@kndl/protocol"
import { Context, Data, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  claudeConfigPath,
  claudeProjectDirName,
  claudeProjectsDir,
  forgetDirectories,
} from "./ClaudeConfig.ts"
import { allocatedBytes } from "./DiskUsage.ts"
import { cloneWorkspace, type GitAuth, GitError } from "./HostGit.ts"
import { HubGit } from "./HubGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { type SessionDirectories, sessionDirectories } from "./SessionNames.ts"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string
}> {}

/**
 * Lays out a Session's directories on the host before its Claude Code starts: the empty
 * directory Claude Code runs in, and the Workspace.
 *
 * Archiving keeps the Workspace, so a restored Session wakes on it; purging removes it.
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
     * Deletes everything of a purged Session on the host: its directory, with the Workspace, and
     * what Claude Code keeps of the directory it ran in.
     * Succeeds when nothing is left.
     */
    readonly remove: (sessionId: SessionId) => Effect.Effect<void, WorkspaceError>
    /**
     * The bytes of the host's disk the Session's directory takes (#352): its Workspace and the rest,
     * as allocated. 0 when it has none.
     */
    readonly usage: (sessionId: SessionId) => Effect.Effect<number>
  }
>()("@kndl/runner/Workspaces") {}

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

/** What a new Hearth's Workspace starts with (ADR 0032): what it is, and where its memory goes. */
export const hearthAgentsFile = `# Hearth

You are a Hearth: the one persistent kndl Session of the person who started you, their main
session for everything. This Workspace is yours alone. It lives on your Runner's disk, not on
GitHub, and outlives every Sandbox: whatever you write here is still here when you wake.

## What you can do

- The \`kndl\` MCP server's tools reach the person's other kndl Sessions, as them: list, read and
  wait for them, create Sessions on a Repo, prompt them, stop their Turns and answer their
  questions. Real work on a Repo belongs in a Session of its own: start one, prompt it, and
  follow it, rather than cloning the Repo here.
- The other MCP servers you have are the Installations on for your Hearth, as for any Repo.

## Memory

- Keep what you should remember in \`MEMORY.md\`: the person's preferences, the Sessions you
  started and why, what is still to do. Read it at the start of a Turn when it could matter.
- Keep notes and files in \`notes/\`. Commit what matters: git here is local, for history.
`

/** The memory file a new Hearth starts with. */
const hearthMemoryFile = `# Memory

Nothing yet.
`

/**
 * Makes a new Hearth's Workspace on the host (ADR 0032): a git repository of its own on its one
 * branch, with no remote, holding what the Hearth is told it is, and its memory.
 */
export const makeHearthWorkspace = (workspace: string) =>
  Effect.try({
    try: () => {
      mkdirSync(join(workspace, "notes"), { recursive: true })
      writeFileSync(join(workspace, "AGENTS.md"), hearthAgentsFile)
      // Claude Code reads CLAUDE.md, pi AGENTS.md: one file for both.
      writeFileSync(join(workspace, "CLAUDE.md"), "@AGENTS.md\n")
      writeFileSync(join(workspace, "MEMORY.md"), hearthMemoryFile)
      writeFileSync(join(workspace, "notes", ".gitkeep"), "")
      const git = (...args: Array<string>) =>
        execFileSync("git", args, { cwd: workspace, stdio: "pipe" })
      git("init", "--quiet", `--initial-branch=${HearthBranch}`)
      git("add", "--all")
      git(
        "-c",
        "user.name=kndl",
        "-c",
        "user.email=kndl@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "The Hearth is lit",
      )
    },
    catch: (cause) => {
      rmSync(workspace, { recursive: true, force: true })
      return new WorkspaceError({
        message: `Could not make the Hearth's Workspace: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    },
  })

/**
 * Asks the Hub how host git reaches the Session's Repo for the clone: with a GitHub App token, or
 * with the host's own credentials.
 */
const cloneAuth = (hubGit: HubGit["Service"], sessionId: SessionId) =>
  Effect.gen(function* () {
    const answer = yield* hubGit.ask(sessionId, { _tag: "GitAccess" })
    if (answer._tag === "GitFailed") return yield* new GitError({ message: answer.message })
    if (answer._tag !== "GitAccess")
      return yield* new GitError({ message: "the Hub gave no Repo access" })
    const credentials = answer.credentials
    return (
      credentials._tag === "AppToken"
        ? { _tag: "Token", token: credentials.token }
        : { _tag: "Host" }
    ) satisfies GitAuth
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
        const auth = yield* cloneAuth(hubGit, start.sessionId)
        yield* cloneWorkspace({
          url: config.repoUrlTemplate.replaceAll("{repo}", start.repo),
          auth,
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
          // A Hearth has no Repo on GitHub to clone (ADR 0032).
          if (isHearthRepo(start.repo)) yield* makeHearthWorkspace(directories.workspace)
          else yield* clone(start, directories.workspace)
          return directories
        }),
      remove: (sessionId) => removeSessionFiles(sessionDirectories(config.sessionsRoot, sessionId)),
      usage: (sessionId) =>
        Effect.promise(() =>
          allocatedBytes(sessionDirectories(config.sessionsRoot, sessionId).session),
        ),
    })
  }),
)
