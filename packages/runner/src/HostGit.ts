// Git on the Runner's host, against a Session's Workspace (ADR 0005, issue #13).
//
// The Workspace, `.git` included, is mounted read-write into the Sandbox, so its `.git/config`,
// `.git/hooks` and `.git/info` may hold whatever the Sandbox wrote there. Host git must never run
// any of it: a hook, a filter driver, an fsmonitor or a credential helper planted there would run
// on the host, with the GitHub token in its environment. So:
//
// - Commands that read the work tree or write objects (add, write-tree, commit-tree, push) run
//   with `GIT_DIR` set to the Runner's own git directory for the Session
//   (SessionDirectories.hostGit), which the Sandbox can't reach and whose config the Runner
//   wrote. They use the Workspace's objects, index and files through `GIT_OBJECT_DIRECTORY`,
//   `GIT_INDEX_FILE` and `GIT_WORK_TREE`, all of which git reads as data.
// - Reading and moving the Workspace's refs (rev-parse, symbolic-ref, update-ref) runs against
//   its own `.git`. These commands run no filter, helper or fsmonitor; hooks are off.
// - Every command runs with `core.hooksPath=/dev/null`: no hook runs, not even the host's own.
// - Pushes go to the URL the Runner builds from RUNNER_REPO_URL, never to `remote.origin.url`.
// - A GitHub App token reaches git only in the environment of the one command that needs it, as
//   an `http.<url>.extraHeader` set through `GIT_CONFIG_COUNT`. It is never written to disk, to a
//   remote URL or to any config file, and never logged.

import { lstat, readdir } from "node:fs/promises"
import { join, posix } from "node:path"
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

export interface GitIdentity {
  readonly name: string
  readonly email: string
}

/** A Session's Workspace, and the Runner's own git directory for it. */
export interface WorkspacePaths {
  readonly workspace: string
  readonly hostGit: string
}

/** The identity WIP commits get when the GitHub App has none to offer. */
export const WipIdentity: GitIdentity = {
  name: "claude-hub",
  email: "claude-hub@users.noreply.github.com",
}

/** Variables from the Runner's own environment that would point git somewhere else. */
const RedirectingVariables =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|ASKPASS)$/

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
  readonly identity?: GitIdentity
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
  // The App's bot doesn't sign with the host user's key.
  if (options.identity !== undefined) config.push(["commit.gpgSign", "false"])
  env["GIT_TERMINAL_PROMPT"] = "0"
  env["GIT_CONFIG_COUNT"] = String(config.length)
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  if (options.identity !== undefined) {
    env["GIT_AUTHOR_NAME"] = options.identity.name
    env["GIT_AUTHOR_EMAIL"] = options.identity.email
    env["GIT_COMMITTER_NAME"] = options.identity.name
    env["GIT_COMMITTER_EMAIL"] = options.identity.email
  }
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
  readonly cwd?: string
  readonly auth?: GitAuth
  readonly remoteUrl?: string
  readonly identity?: GitIdentity
  readonly variables?: Readonly<Record<string, string>>
}

const git = (args: ReadonlyArray<string>, options: RunOptions = {}) =>
  runCommand("git", args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: gitEnvironment(options),
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.mapError((error) => new GitError({ message: scrub(error.message, options.auth) })),
  )

const gitDir = (paths: WorkspacePaths) => join(paths.workspace, ".git")

/** git on the Workspace's own `.git`, for its refs only. */
const refGit = (paths: WorkspacePaths, args: ReadonlyArray<string>) =>
  git(args, { cwd: paths.hostGit, variables: { GIT_DIR: gitDir(paths) } })

/** git with the Runner's own git directory over the Workspace's files, objects and `index`. */
const treeGit = (
  paths: WorkspacePaths,
  args: ReadonlyArray<string>,
  options: Omit<RunOptions, "cwd" | "variables"> & { readonly index?: string } = {},
) =>
  git(args, {
    ...options,
    cwd: paths.workspace,
    variables: {
      GIT_DIR: paths.hostGit,
      GIT_WORK_TREE: paths.workspace,
      GIT_OBJECT_DIRECTORY: join(gitDir(paths), "objects"),
      GIT_INDEX_FILE: options.index ?? join(gitDir(paths), "index"),
    },
  })

/** The kind of file at `path`, without following a link; undefined when there is none. */
const kindOf = (path: string) =>
  Effect.promise(() =>
    lstat(path).then(
      (stats) =>
        stats.isSymbolicLink()
          ? ("link" as const)
          : stats.isDirectory()
            ? ("directory" as const)
            : stats.isFile()
              ? ("file" as const)
              : ("other" as const),
      () => undefined,
    ),
  )

const refuse = (what: string) =>
  new GitError({
    message: `host git refused the Workspace: its .git${what} is a link or not a plain git file`,
  })

/**
 * Checks the Workspace's `.git` holds no link where host git reads or writes: the directory
 * itself, the index, HEAD, the object directories, and the refs and reflogs of `branches`. A link
 * planted by the Sandbox would send host git's writes, such as a new index or a reflog line, to
 * any file the Runner's user can write.
 */
const checkGitDir = (paths: WorkspacePaths, branches: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = gitDir(paths)
    if ((yield* kindOf(dir)) !== "directory") return yield* refuse("")
    // A linked worktree's `.git` would point refs and config at another directory.
    if ((yield* kindOf(join(dir, "commondir"))) !== undefined) return yield* refuse("/commondir")
    const files = ["index", "HEAD", "packed-refs", "info/exclude", "logs/HEAD"]
    for (const branch of branches)
      for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`])
        files.push(ref, `logs/${ref}`)
    for (const file of files) {
      // Every directory on the way, then the file itself, which may be missing.
      const parts = file.split("/")
      for (let depth = 1; depth <= parts.length; depth++) {
        const relative = parts.slice(0, depth).join("/")
        const kind = yield* kindOf(join(dir, relative))
        if (kind === undefined) break
        if (kind !== (depth === parts.length ? "file" : "directory"))
          return yield* refuse(`/${relative}`)
      }
    }
    if ((yield* kindOf(join(dir, "objects"))) !== "directory") return yield* refuse("/objects")
    const objects = yield* Effect.promise(() =>
      readdir(join(dir, "objects"), { withFileTypes: true }),
    )
    const linked = objects.find((entry) => entry.isSymbolicLink())
    if (linked !== undefined) return yield* refuse(`/objects/${linked.name}`)
  })

/**
 * Makes the Runner's own git directory for the Workspace if it isn't there yet, and copies the
 * Workspace's `info/exclude` into it, so untracked files the Workspace ignores stay out of WIP
 * snapshots. Exclude patterns are only data.
 */
const prepareHostGit = (paths: WorkspacePaths, branches: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    yield* checkGitDir(paths, branches)
    if ((yield* kindOf(join(paths.hostGit, "HEAD"))) === undefined) {
      yield* git(["init", "--quiet", "--bare", paths.hostGit])
      yield* git(["config", "core.bare", "false"], { variables: { GIT_DIR: paths.hostGit } })
    }
    const exclude = yield* Effect.promise(() =>
      Bun.file(join(gitDir(paths), "info", "exclude"))
        .text()
        .catch(() => ""),
    )
    yield* Effect.promise(() => Bun.write(join(paths.hostGit, "info", "exclude"), exclude))
  })

/** The commit `ref` names in the Workspace, or undefined when there is none. */
const resolveCommit = (paths: WorkspacePaths, ref: string) =>
  refGit(paths, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.map((sha) => (sha === "" ? undefined : sha)),
    Effect.catchTag("GitError", () => Effect.succeed(undefined)),
  )

/** The branch the Workspace has checked out, or undefined when its HEAD is detached. */
export const currentBranch = (paths: WorkspacePaths) =>
  refGit(paths, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
    Effect.map((ref) =>
      ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined,
    ),
    Effect.catchTag("GitError", () => Effect.succeed(undefined)),
  )

/** Clones `url` into `workspace` on `baseBranch`, then creates and checks out `workBranch`. */
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
    yield* git(["-C", options.workspace, "switch", "--quiet", "--create", options.workBranch])
  })

/** What `git_commit` stages before committing. */
export type Staging =
  | { readonly _tag: "Staged" }
  | { readonly _tag: "All" }
  | { readonly _tag: "Paths"; readonly paths: ReadonlyArray<string> }

export interface Committed {
  readonly commit: string
  readonly parent: string
  /** The files the commit changed, as `git diff --name-status` lists them. */
  readonly changes: ReadonlyArray<string>
}

/**
 * Stages `staging` in the Workspace's index and commits what is staged onto `workBranch`, which
 * must be checked out. The commit is made with commit-tree and the branch moved with update-ref,
 * only if it hasn't moved meanwhile.
 */
export const commitWorkspace = (
  paths: WorkspacePaths,
  options: {
    readonly workBranch: string
    readonly message: string
    readonly staging: Staging
    readonly identity?: GitIdentity
  },
) =>
  Effect.gen(function* () {
    yield* prepareHostGit(paths, [options.workBranch])
    const branch = yield* currentBranch(paths)
    if (branch !== options.workBranch)
      return yield* new GitError({
        message: `The Workspace is on ${branch === undefined ? "a detached HEAD" : `branch ${branch}`}, not the Work branch ${options.workBranch}. Commits go on the Work branch only: switch back with \`git switch ${options.workBranch}\`.`,
      })
    const parent = yield* resolveCommit(paths, `refs/heads/${options.workBranch}`)
    if (parent === undefined)
      return yield* new GitError({ message: `the Work branch ${options.workBranch} has no commit` })

    switch (options.staging._tag) {
      case "All":
        yield* treeGit(paths, ["add", "--all"])
        break
      case "Paths":
        yield* treeGit(paths, [
          "add",
          "--all",
          "--",
          ...options.staging.paths.map((path) => `:(literal)${path}`),
        ])
        break
      case "Staged":
        break
    }
    const tree = yield* treeGit(paths, ["write-tree"])
    const changes = yield* treeGit(paths, [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      parent,
      tree,
    ])
    if (changes === "")
      return yield* new GitError({
        message:
          "Nothing to commit: nothing is staged that differs from the last commit. Pass `paths`, or `all: true` to commit every change.",
      })
    const commit = yield* treeGit(
      paths,
      ["commit-tree", tree, "-p", parent, "-m", options.message],
      options.identity === undefined ? {} : { identity: options.identity },
    )
    yield* refGit(paths, [
      "update-ref",
      "-m",
      "claude-hub: git_commit",
      `refs/heads/${options.workBranch}`,
      commit,
      parent,
    ])
    return { commit, parent, changes: changes.split("\n") } satisfies Committed
  })

/**
 * Pushes the Work branch to `url`, never forced: a remote branch with commits the Workspace
 * lacks rejects it. Moves the Workspace's `refs/remotes/origin/<branch>` along. Returns the
 * commit pushed.
 */
export const pushWorkBranch = (
  paths: WorkspacePaths,
  options: { readonly url: string; readonly auth: GitAuth; readonly workBranch: string },
) =>
  Effect.gen(function* () {
    yield* prepareHostGit(paths, [options.workBranch])
    const ref = `refs/heads/${options.workBranch}`
    const commit = yield* resolveCommit(paths, ref)
    if (commit === undefined)
      return yield* new GitError({ message: `the Work branch ${options.workBranch} has no commit` })
    yield* treeGit(
      paths,
      ["push", "--quiet", "--no-verify", "--", options.url, `${commit}:${ref}`],
      {
        auth: options.auth,
        remoteUrl: options.url,
      },
    ).pipe(
      Effect.mapError((error) =>
        /\[rejected\]|non-fast-forward|fetch first/.test(error.message)
          ? new GitError({
              message: `The push was rejected: the remote ${options.workBranch} has commits this Workspace doesn't have. Nothing was force-pushed. (${error.message})`,
            })
          : error,
      ),
    )
    yield* refGit(paths, ["update-ref", `refs/remotes/origin/${options.workBranch}`, commit]).pipe(
      Effect.ignore,
    )
    return commit
  })

export interface SnapshotTree {
  readonly tree: string
  /** The Workspace's HEAD commit, the snapshot's parent. */
  readonly parent: string
}

/**
 * Writes the tree of everything in the Workspace, uncommitted and untracked files included but
 * not ignored ones, and reads the Workspace's HEAD. Neither the Workspace's index nor any of its
 * branches changes: the files are staged in the Runner's own index file.
 */
export const snapshotTree = (paths: WorkspacePaths) =>
  Effect.gen(function* () {
    yield* prepareHostGit(paths)
    const parent = yield* resolveCommit(paths, "HEAD")
    if (parent === undefined)
      return yield* new GitError({ message: "the Workspace has no HEAD commit" })
    // Kept between snapshots, so git rehashes only the files that changed.
    const index = join(paths.hostGit, "wip-index")
    yield* treeGit(paths, ["add", "--all"], { index })
    const tree = yield* treeGit(paths, ["write-tree"], { index })
    return { tree, parent } satisfies SnapshotTree
  })

/** Makes the snapshot commit of `snapshot`, with the Workspace's HEAD as its parent. */
export const commitSnapshot = (
  paths: WorkspacePaths,
  snapshot: SnapshotTree,
  options: { readonly message: string; readonly identity: GitIdentity },
) =>
  treeGit(paths, ["commit-tree", snapshot.tree, "-p", snapshot.parent, "-m", options.message], {
    identity: options.identity,
  })

/** Force-pushes `commit` to `ref` on `url`: that ref only, as the WIP ref is. */
export const forcePushRef = (
  paths: WorkspacePaths,
  options: {
    readonly url: string
    readonly auth: GitAuth
    readonly commit: string
    readonly ref: string
  },
) =>
  treeGit(
    paths,
    ["push", "--quiet", "--no-verify", "--", options.url, `+${options.commit}:${options.ref}`],
    {
      auth: options.auth,
      remoteUrl: options.url,
    },
  ).pipe(Effect.asVoid)

/**
 * A path the model gave, relative to the Workspace: one under any of `roots` (the paths the
 * model knows the Workspace by) is made relative, and one leading out of the Workspace is
 * refused.
 */
export const workspaceRelative = (
  path: string,
  roots: ReadonlyArray<string>,
): string | undefined => {
  let relative = path
  if (posix.isAbsolute(path)) {
    const root = roots.find((candidate) => path === candidate || path.startsWith(`${candidate}/`))
    if (root === undefined) return undefined
    relative = path.slice(root.length + 1)
  }
  const normal = posix.normalize(relative === "" ? "." : relative)
  if (normal === ".." || normal.startsWith("../") || posix.isAbsolute(normal)) return undefined
  return normal
}
