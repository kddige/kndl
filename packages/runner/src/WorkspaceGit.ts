// The git tools and the WIP ref (issue #13, ADR 0005): git on a Session's Workspace, run by the
// Runner on its host and never in the Sandbox.
//
// - The mod's git tools reach the Runner on the Session's tool bridge socket (`POST /git/call`);
//   `call` answers them. A token stays with the Runner, which asks the Hub for one per call.
// - `pushWip` force-pushes a snapshot of the Workspace to `refs/claude-hub/wip/<session>`: after
//   a Turn that changed it, and before the Session sleeps or is archived. A failure is logged and
//   reported to the Hub, and never stops anything else.
//
// One git operation runs at a time per Session.

import { join } from "node:path"
import {
  GitCommitInput,
  type GitIdentity,
  type GitToolCall,
  OpenPrInput,
  ReviewPrInput,
  type SessionId,
  ToolBridgeReply,
  wipRef,
} from "@claude-hub/protocol"
import { Cause, Context, Duration, Effect, Exit, Layer, Schema, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  commitSnapshot,
  commitWorkspace,
  forcePushRef,
  type GitAuth,
  GitError,
  pushWorkBranch,
  snapshotTree,
  type Staging,
  WipIdentity,
  type WorkspacePaths,
  workspaceRelative,
} from "./HostGit.ts"
import { HubGit } from "./HubGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import type { SessionDirectories } from "./SessionNames.ts"

/** Why a WIP push runs. */
export type WipReason = "TurnEnded" | "Sleep" | "Archive"

/** How long one git tool call may take, pushes included. */
export const GitToolTimeout = Duration.minutes(5)

/** How long a WIP push may hold up whatever comes after it, such as the Sandbox stopping. */
export const WipPushTimeout = Duration.minutes(2)

export class WorkspaceGit extends Context.Service<
  WorkspaceGit,
  {
    /** Answers one git tool call from the mod. Never fails: errors are `ToolFailed`. */
    readonly call: (
      sessionId: SessionId,
      directories: SessionDirectories,
      call: GitToolCall,
    ) => Effect.Effect<ToolBridgeReply>
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

/**
 * `message` with a `Co-authored-by` trailer for each of `coAuthors` it doesn't already carry,
 * added to its trailer block if it ends with one.
 */
export const withCoAuthors = (message: string, coAuthors: ReadonlyArray<GitIdentity>): string => {
  const body = message.trimEnd()
  const present = new Set(
    body
      .split("\n")
      .map((line) => /^co-authored-by:\s*.*<([^>]+)>\s*$/i.exec(line)?.[1]?.toLowerCase())
      .filter((email) => email !== undefined),
  )
  const trailers: Array<string> = []
  for (const person of coAuthors) {
    const email = person.email.toLowerCase()
    if (present.has(email)) continue
    present.add(email)
    trailers.push(`Co-authored-by: ${person.name} <${person.email}>`)
  }
  if (trailers.length === 0) return body
  const paragraphs = body.split(/\n\s*\n/)
  const last = paragraphs.at(-1) ?? ""
  const endsWithTrailers =
    paragraphs.length > 1 && last.split("\n").every((line) => /^[A-Za-z][\w-]*: \S/.test(line))
  return `${body}${endsWithTrailers ? "\n" : "\n\n"}${trailers.join("\n")}`
}

/** The Repo access a GitAccess answer gave. */
export interface RepoAccess {
  readonly repo: string
  readonly workBranch: string
  readonly url: string
  readonly auth: GitAuth
  /** The App's bot, when there is one; commits are authored by the host's identity otherwise. */
  readonly author: GitIdentity | undefined
}

/**
 * Asks the Hub how to reach the Session's Repo: its branches, the URL the Runner pushes to (from
 * RUNNER_REPO_URL, never the Workspace's own config), and a token or the host's credentials.
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
      repo: answer.repo,
      workBranch: answer.workBranch,
      url: repoUrlTemplate.replaceAll("{repo}", answer.repo),
      auth:
        credentials._tag === "AppToken"
          ? { _tag: "Token", token: credentials.token }
          : { _tag: "Host" },
      author: credentials._tag === "AppToken" ? credentials.author : undefined,
    } satisfies RepoAccess
  })

const ran = (text: string) => ToolBridgeReply.cases.ToolRan.make({ result: text })
const failed = (message: string) => ToolBridgeReply.cases.ToolFailed.make({ message })

const short = (sha: string) => sha.slice(0, 7)

/** Checks a tool's input against its schema, as a GitError the model can act on. */
const decodeInput =
  <S extends Schema.Top & { readonly DecodingServices: never }>(tool: string, schema: S) =>
  (input: unknown) => {
    const exit = Schema.decodeUnknownExit(schema)(input)
    if (Exit.isSuccess(exit)) return Effect.succeed(exit.value)
    const error = Cause.squash(exit.cause)
    return Effect.fail(
      new GitError({
        message: `${tool} was called with input it doesn't take: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
  }

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

    // ── The tools ────────────────────────────────────────────────────────

    const gitCommit = (sessionId: SessionId, directories: SessionDirectories, raw: unknown) =>
      Effect.gen(function* () {
        const input = yield* decodeInput("git_commit", GitCommitInput)(raw)
        if (input.all === true && input.paths !== undefined && input.paths.length > 0)
          return yield* new GitError({ message: "Pass `paths` or `all: true`, not both." })
        let staging: Staging = { _tag: "Staged" }
        if (input.all === true) staging = { _tag: "All" }
        else if (input.paths !== undefined && input.paths.length > 0) {
          const roots = [directories.claude, workspaceGuestPath, directories.workspace]
          const relative: Array<string> = []
          for (const path of input.paths) {
            const inside = workspaceRelative(path, roots)
            if (inside === undefined)
              return yield* new GitError({ message: `${path} is not in the Workspace.` })
            relative.push(inside)
          }
          staging = { _tag: "Paths", paths: relative }
        }

        const repo = yield* access(sessionId)
        // The Hub is the source of truth for the trailers; no commit goes without them.
        const counted = yield* hubGit.ask(sessionId, { _tag: "CoAuthors" })
        if (counted._tag === "GitFailed") return yield* new GitError({ message: counted.message })
        if (counted._tag !== "CoAuthors")
          return yield* new GitError({ message: "the Hub did not say who the co-authors are" })
        const message = withCoAuthors(input.message, counted.coAuthors)
        const committed = yield* commitWorkspace(paths(directories), {
          workBranch: repo.workBranch,
          message,
          staging,
          ...(repo.author === undefined ? {} : { identity: repo.author }),
        })
        yield* hubGit.committed(sessionId, counted.through)
        const lines = [
          `Committed ${short(committed.commit)} on ${repo.workBranch}: ${input.message.split("\n")[0]}`,
          repo.author === undefined
            ? "Author: the Runner host's git identity"
            : `Author: ${repo.author.name} <${repo.author.email}>`,
          ...counted.coAuthors.map((person) => `Co-authored-by: ${person.name} <${person.email}>`),
          "",
          ...committed.changes,
          "",
          "Not pushed yet: git_push pushes the Work branch.",
        ]
        return lines.join("\n")
      })

    const gitPush = (sessionId: SessionId, directories: SessionDirectories) =>
      Effect.gen(function* () {
        const repo = yield* access(sessionId)
        const commit = yield* pushWorkBranch(paths(directories), {
          url: repo.url,
          auth: repo.auth,
          workBranch: repo.workBranch,
        })
        return `Pushed ${repo.workBranch} (${short(commit)}) to ${repo.repo}.`
      })

    const openPr = (sessionId: SessionId, raw: unknown) =>
      Effect.gen(function* () {
        const input = yield* decodeInput("open_pr", OpenPrInput)(raw)
        const answer = yield* hubGit.ask(sessionId, {
          _tag: "OpenPullRequest",
          title: input.title,
          body: input.body ?? "",
          draft: input.draft ?? false,
        })
        if (answer._tag === "GitFailed") return yield* new GitError({ message: answer.message })
        if (answer._tag !== "PullRequest")
          return yield* new GitError({ message: "the Hub did not open a pull request" })
        return answer.existing
          ? `A pull request from the Work branch is already open: #${answer.number} ${answer.url}`
          : `Opened pull request #${answer.number}: ${answer.url}`
      })

    const reviewPr = (sessionId: SessionId, raw: unknown) =>
      Effect.gen(function* () {
        const input = yield* decodeInput("review_pr", ReviewPrInput)(raw)
        const answer = yield* hubGit.ask(sessionId, {
          _tag: "ReviewPullRequest",
          number: input.number,
          body: input.body,
          event: input.event ?? "COMMENT",
        })
        if (answer._tag === "GitFailed") return yield* new GitError({ message: answer.message })
        if (answer._tag !== "ReviewPosted")
          return yield* new GitError({ message: "the Hub did not post the review" })
        return `Posted a review on #${input.number}: ${answer.url}`
      })

    const call = (sessionId: SessionId, directories: SessionDirectories, request: GitToolCall) => {
      const run = (() => {
        switch (request.tool) {
          case "git_commit":
            return serialized(sessionId)(gitCommit(sessionId, directories, request.input))
          case "git_push":
            return serialized(sessionId)(gitPush(sessionId, directories))
          case "open_pr":
            return openPr(sessionId, request.input)
          case "review_pr":
            return reviewPr(sessionId, request.input)
        }
      })()
      return run.pipe(
        Effect.map(ran),
        Effect.timeoutOrElse({
          duration: GitToolTimeout,
          orElse: () =>
            Effect.fail(
              new GitError({ message: `${request.tool} took too long and was stopped.` }),
            ),
        }),
        Effect.catchTag("GitError", (error) => Effect.succeed(failed(error.message))),
        Effect.catchCause((cause) =>
          Effect.logError(`Session ${sessionId}: ${request.tool} failed`, cause).pipe(
            Effect.as(failed(`${request.tool} failed on the Runner.`)),
          ),
        ),
      )
    }

    // ── The WIP ref ──────────────────────────────────────────────────────

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

    return WorkspaceGit.of({ call, pushWip })
  }),
)

/** No git: every git tool is refused and WIP pushes do nothing. */
export const NoWorkspaceGit = Layer.succeed(
  WorkspaceGit,
  WorkspaceGit.of({
    call: (_sessionId, _directories, request) =>
      Effect.succeed(failed(`${request.tool} is not available on this Runner.`)),
    pushWip: () => Effect.void,
  }),
)
