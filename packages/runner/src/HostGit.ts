// Git on the Runner's host (ADR 0010): only clones, each into a new directory, before any Sandbox
// has it. Everything else git does runs in the Sandbox: commits, pushes, `gh`.
//
// Even so, host git trusts nothing it didn't make:
//
// - Every command runs with `core.hooksPath=/dev/null` and fsmonitor off: no hook runs, not even
//   the host's own.
// - Variables from the Runner's environment that would point git at another directory, or hand it
//   other config, are dropped.
// - A GitHub App token reaches git only in the environment of the one command that needs it, as
//   an `http.<url>.extraHeader` set through `GIT_CONFIG_COUNT`. It is never written to disk, to a
//   remote URL or to any config file, and never logged.

import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"
import { Data, Effect, Redacted } from "effect"
import { hostEnvironment, runCommand } from "./Process.ts"

export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string
}> {}

/** How git authenticates to the Repo's remote. */
export type GitAuth =
  /** A GitHub App installation token, sent as an HTTP header. */
  | { readonly _tag: "Token"; readonly token: Redacted.Redacted<string> }
  /** The host's own git credentials (dev mode, without the GitHub App). */
  | { readonly _tag: "Host" }

/**
 * Variables from the Runner's own environment that would point git somewhere else, such as
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, which has git read objects from other directories.
 */
const RedirectingVariables =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|ASKPASS)$/

/** The header GitHub takes an installation token in, for git over HTTPS. */
export const authorizationHeader = (token: Redacted.Redacted<string>) =>
  `Authorization: Basic ${btoa(`x-access-token:${Redacted.value(token)}`)}`

/**
 * The environment one git command runs with: the Runner's, without anything that redirects git,
 * with hooks and fsmonitor off and no terminal prompt, plus `config` entries passed through
 * `GIT_CONFIG_COUNT`. With a token, `remoteUrl` gets it as a header, and the host's credential
 * helpers are cleared so none of them runs or stores anything.
 */
export const gitEnvironment = (options: {
  readonly auth?: GitAuth
  readonly remoteUrl?: string
  readonly variables?: Readonly<Record<string, string>>
}): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(hostEnvironment()))
    if (!RedirectingVariables.test(key)) env[key] = value
  const config: Array<readonly [string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
  ]
  if (options.auth?._tag === "Token") {
    if (options.remoteUrl === undefined) throw new Error("a token needs the remote URL it is for")
    config.push(["credential.helper", ""])
    config.push([`http.${options.remoteUrl}.extraHeader`, authorizationHeader(options.auth.token)])
  }
  env["GIT_TERMINAL_PROMPT"] = "0"
  env["GIT_CONFIG_COUNT"] = String(config.length)
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return { ...env, ...options.variables }
}

/** `message` without the token or its header, should git ever echo either. */
const scrub = (message: string, auth: GitAuth | undefined) => {
  if (auth?._tag !== "Token") return message
  const token = Redacted.value(auth.token)
  const header = authorizationHeader(auth.token)
  return message.replaceAll(header, "Authorization: ***").replaceAll(token, "***")
}

interface RunOptions {
  readonly auth?: GitAuth
  readonly remoteUrl?: string
}

const git = (args: ReadonlyArray<string>, options: RunOptions = {}) =>
  runCommand("git", args, { env: gitEnvironment(options) }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.mapError((error) => new GitError({ message: scrub(error.message, options.auth) })),
  )

/** Where subagents' worktrees are, as an exclude pattern (ADR 0014). */
export const AgentWorktreesPattern = "/.claude/worktrees/"

/**
 * Has the new Workspace's `info/exclude` ignore subagents' worktrees (ADR 0014), so a `git add -A`
 * in the Sandbox doesn't take one in as an embedded repository: their `.git` files point at guest
 * paths. The line is appended once, through no link at the file.
 */
const excludeAgentWorktrees = (workspace: string) =>
  Effect.gen(function* () {
    const info = join(workspace, ".git", "info")
    const path = join(info, "exclude")
    const exclude = yield* Effect.promise(() =>
      Bun.file(path)
        .text()
        .catch(() => ""),
    )
    if (exclude.split("\n").includes(AgentWorktreesPattern)) return
    const line = `${exclude === "" || exclude.endsWith("\n") ? "" : "\n"}${AgentWorktreesPattern}\n`
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(info, { recursive: true })
        const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
        const file = await open(path, flags | constants.O_NOFOLLOW, 0o644)
        try {
          await file.write(line)
        } finally {
          await file.close()
        }
      },
      catch: (error) =>
        new GitError({ message: `couldn't exclude agents' worktrees in the Workspace: ${error}` }),
    })
  })

/**
 * Clones `url` into `workspace` on `baseBranch`, then creates and checks out `workBranch`, with
 * subagents' worktrees excluded. A new `workBranch` that the Repo already has fails. A `workBranch` that is the `baseBranch` is already checked out:
 * the Session commits to it directly.
 */
export const cloneWorkspace = (options: {
  readonly url: string
  readonly auth: GitAuth
  readonly workspace: string
  readonly baseBranch: string
  readonly workBranch: string
}) =>
  Effect.gen(function* () {
    const run = { auth: options.auth, remoteUrl: options.url }
    yield* git(
      ["clone", "--quiet", "--branch", options.baseBranch, "--", options.url, options.workspace],
      run,
    )
    if (options.workBranch !== options.baseBranch) {
      // A new branch must be new: made over one that is on the remote, a later push could
      // overwrite it.
      const exists = yield* git([
        "-C",
        options.workspace,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${options.workBranch}`,
      ]).pipe(
        Effect.as(true),
        Effect.catchTag("GitError", () => Effect.succeed(false)),
      )
      if (exists) {
        return yield* new GitError({
          message: `the branch ${options.workBranch} already exists in the Repo: pick another name, or work on it directly`,
        })
      }
      yield* git(["-C", options.workspace, "switch", "--quiet", "--create", options.workBranch])
    }
    yield* excludeAgentWorktrees(options.workspace)
  })

/**
 * Clones the tip of `url`'s default branch into `directory`, which must be missing or empty: a
 * Test build's fresh clone (ADR 0009).
 */
export const cloneDefaultBranch = (options: {
  readonly url: string
  readonly auth: GitAuth
  readonly directory: string
}) =>
  git(["clone", "--quiet", "--depth", "1", "--", options.url, options.directory], {
    auth: options.auth,
    remoteUrl: options.url,
  }).pipe(Effect.asVoid)
