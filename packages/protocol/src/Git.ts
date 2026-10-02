import { Schema } from "effect"
import { SessionId } from "./Ids.ts"
import { BranchName, EpochMillis, RepoName } from "./Session.ts"

// Git from Sessions (issue #13, ADR 0005). Commits, pushes and pull requests run on the host,
// never in the Sandbox:
//
// - The mod registers the git tools (`git_commit`, `git_push`, `open_pr`, `review_pr`) and
//   answers them through the Runner, on the Session's tool bridge socket: `POST /git/call`, body
//   GitToolCall, answered with a ToolBridgeReply (ToolBridge.ts). The mod never sees a token.
// - The Runner asks the Hub for what it needs over its WebSocket, with a GitRequest the Hub
//   answers with a GitReply of the same `requestId`. Only the Hub holds the GitHub App's key: it
//   mints a short-lived installation token, scoped to the Session's Repo, per request.
// - The Hub knows who prompted since the last commit (the Co-authored-by trailers) and resets
//   that list when the Runner reports the commit with CoAuthorsCommitted.

// ── The git tools, mod to Runner ───────────────────────────────────────────

/** The git tools the mod registers, as `mcp__hub-link__<name>`. */
export const GitTools = ["git_commit", "git_push", "open_pr", "review_pr"] as const
export type GitTool = (typeof GitTools)[number]

/** One git tool call: the tool and its arguments as the model gave them, checked by the Runner. */
export const GitToolCall = Schema.Struct({
  tool: Schema.Literals(GitTools),
  input: Schema.Record(Schema.String, Schema.Unknown),
})
export type GitToolCall = typeof GitToolCall.Type

/** `git_commit`: stage `paths`, or everything with `all`, then commit what is staged. */
export const GitCommitInput = Schema.Struct({
  message: Schema.NonEmptyString,
  paths: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  all: Schema.optionalKey(Schema.Boolean),
})
export type GitCommitInput = typeof GitCommitInput.Type

/** `git_push`: push the Work branch. It takes nothing: the branch and remote are fixed. */
export const GitPushInput = Schema.Struct({})
export type GitPushInput = typeof GitPushInput.Type

/** `open_pr`: open a pull request from the Work branch into the base branch. */
export const OpenPrInput = Schema.Struct({
  title: Schema.NonEmptyString,
  body: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.Boolean),
})
export type OpenPrInput = typeof OpenPrInput.Type

/** What a review does, as GitHub names it. */
export const ReviewEvent = Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
export type ReviewEvent = typeof ReviewEvent.Type

/** `review_pr`: post a review on a pull request of the Repo. */
export const ReviewPrInput = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.NonEmptyString,
  event: Schema.optionalKey(ReviewEvent),
})
export type ReviewPrInput = typeof ReviewPrInput.Type

// ── Runner to Hub, and back ────────────────────────────────────────────────

/** Chosen by the Runner to match the Hub's GitReply to its GitRequest. */
export const GitRequestId = Schema.NonEmptyString.pipe(Schema.brand("GitRequestId"))
export type GitRequestId = typeof GitRequestId.Type

/** A commit author or co-author: `name <email>`. */
export const GitIdentity = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
})
export type GitIdentity = typeof GitIdentity.Type

/** What a GitRequest asks the Hub for. */
export const GitAsk = Schema.Union([
  /** The Session's Repo and branches, and how to authenticate to it now. */
  Schema.TaggedStruct("GitAccess", {}),
  /** Who prompted since the last commit, as Co-authored-by trailers. */
  Schema.TaggedStruct("CoAuthors", {}),
  /** Open a pull request from the Work branch into the base branch, or find the open one. */
  Schema.TaggedStruct("OpenPullRequest", {
    title: Schema.NonEmptyString,
    body: Schema.String,
    draft: Schema.Boolean,
  }),
  /** Post a review on a pull request of the Session's Repo. */
  Schema.TaggedStruct("ReviewPullRequest", {
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    body: Schema.NonEmptyString,
    event: ReviewEvent,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GitAsk = typeof GitAsk.Type

/** Runner to Hub: a question about one of the Runner's Sessions, answered with a GitReply. */
export const GitRequest = Schema.TaggedStruct("GitRequest", {
  requestId: GitRequestId,
  sessionId: SessionId,
  ask: GitAsk,
})
export type GitRequest = typeof GitRequest.Type

/** How the Runner authenticates git to the Repo. */
export const GitCredentials = Schema.Union([
  /**
   * A GitHub App installation token, scoped to the Session's Repo. The Runner hands it to git per
   * command and never stores it: not on disk, not in a remote URL, not in `.git/config`.
   */
  Schema.TaggedStruct("AppToken", {
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
    expiresAt: EpochMillis,
    /** The App's bot, which commits are authored by. */
    author: GitIdentity,
  }),
  /**
   * The Hub has no GitHub App configured (dev mode): git uses the host's own credentials and
   * identity, and pull requests are unavailable.
   */
  Schema.TaggedStruct("HostCredentials", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GitCredentials = typeof GitCredentials.Type

/** The Hub's answer to a GitRequest. */
export const GitAnswer = Schema.Union([
  Schema.TaggedStruct("GitAccess", {
    repo: RepoName,
    baseBranch: BranchName,
    workBranch: BranchName,
    credentials: GitCredentials,
  }),
  Schema.TaggedStruct("CoAuthors", {
    coAuthors: Schema.Array(GitIdentity),
    /** Report this back with CoAuthorsCommitted once the commit is made. */
    through: Schema.Natural,
  }),
  Schema.TaggedStruct("PullRequest", {
    number: Schema.Int,
    url: Schema.String,
    /** True when an open pull request from the Work branch already existed. */
    existing: Schema.Boolean,
  }),
  Schema.TaggedStruct("ReviewPosted", { url: Schema.String }),
  /** The Hub couldn't answer; `message` is for the model. */
  Schema.TaggedStruct("GitFailed", { message: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GitAnswer = typeof GitAnswer.Type

/** Hub to Runner: the answer to the GitRequest with the same `requestId`. */
export const GitReply = Schema.TaggedStruct("GitReply", {
  requestId: GitRequestId,
  answer: GitAnswer,
})
export type GitReply = typeof GitReply.Type

/**
 * Runner to Hub: a commit was made with the co-authors of a CoAuthors answer. The Hub forgets
 * the prompts it counted, up to `through`; prompts delivered since stay for the next commit.
 */
export const CoAuthorsCommitted = Schema.TaggedStruct("CoAuthorsCommitted", {
  sessionId: SessionId,
  through: Schema.Natural,
})
export type CoAuthorsCommitted = typeof CoAuthorsCommitted.Type

/** Runner to Hub: pushing the WIP ref failed. The Hub records it in the Session's log. */
export const WipPushFailed = Schema.TaggedStruct("WipPushFailed", {
  sessionId: SessionId,
  message: Schema.String,
})
export type WipPushFailed = typeof WipPushFailed.Type

/**
 * Hub to Runner: the Session's Turn ended, so its Workspace may have changed. The Runner pushes
 * the WIP ref if it did.
 */
export const SessionTurnEnded = Schema.TaggedStruct("SessionTurnEnded", {
  sessionId: SessionId,
})
export type SessionTurnEnded = typeof SessionTurnEnded.Type

/** The ref a Session's WIP snapshot is force-pushed to on origin. */
export const wipRef = (sessionId: SessionId | string) => `refs/claude-hub/wip/${sessionId}`
