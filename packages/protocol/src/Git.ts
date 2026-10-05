import { Schema } from "effect"
import { SessionId } from "./Ids.ts"
import { EpochMillis, RepoName } from "./Session.ts"

// Git from Sessions (issue #73, ADR 0010). `git` and `gh` run in the Sandbox with a short-lived
// GitHub App installation token the Runner keeps there. The Runner's host runs only the clone and
// the automatic WIP ref pushes.
//
// The Runner asks the Hub for what it needs over its WebSocket, with a GitRequest the Hub answers
// with a GitReply of the same `requestId`. Only the Hub holds the GitHub App's key: it mints the
// tokens, each scoped to the Session's Repo.

/** Chosen by the Runner to match the Hub's GitReply to its GitRequest. */
export const GitRequestId = Schema.NonEmptyString.pipe(Schema.brand("GitRequestId"))
export type GitRequestId = typeof GitRequestId.Type

/** A commit author: `name <email>`. */
export const GitIdentity = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
})
export type GitIdentity = typeof GitIdentity.Type

/** What a GitRequest asks the Hub for. */
export const GitAsk = Schema.Union([
  /** The Session's Repo, and how the Runner's host git authenticates to it now. */
  Schema.TaggedStruct("GitAccess", {}),
  /** A fresh token for the Session's Sandbox, where `git` and `gh` use it. */
  Schema.TaggedStruct("SandboxToken", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GitAsk = typeof GitAsk.Type

/** Runner to Hub: a question about one of the Runner's Sessions, answered with a GitReply. */
export const GitRequest = Schema.TaggedStruct("GitRequest", {
  requestId: GitRequestId,
  sessionId: SessionId,
  ask: GitAsk,
})
export type GitRequest = typeof GitRequest.Type

/** How the Runner's host git authenticates to the Repo. */
export const GitCredentials = Schema.Union([
  /**
   * A GitHub App installation token, scoped to the Session's Repo. The Runner hands it to host git
   * per command and never stores it: not on disk, not in a remote URL, not in `.git/config`.
   */
  Schema.TaggedStruct("AppToken", {
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
    expiresAt: EpochMillis,
    /** The App's bot, which WIP commits are authored by. */
    author: GitIdentity,
  }),
  /**
   * The Hub has no GitHub App configured (dev mode): host git uses the host's own credentials and
   * identity, and the Sandbox gets no token.
   */
  Schema.TaggedStruct("HostCredentials", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GitCredentials = typeof GitCredentials.Type

/** The Hub's answer to a GitRequest. */
export const GitAnswer = Schema.Union([
  Schema.TaggedStruct("GitAccess", {
    repo: RepoName,
    credentials: GitCredentials,
  }),
  /**
   * An installation token minted for the Sandbox alone: scoped to the Session's Repo, with every
   * permission the App's installation has. The Hub redacts it, and the Session's previous one,
   * from what the Session prints.
   */
  Schema.TaggedStruct("SandboxToken", {
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
    expiresAt: EpochMillis,
  }),
  /**
   * How the Runner's host git clones a Test build's Repo (#104): with a fresh installation token,
   * `contents:read` and scoped to the Repo, handed to git for the one clone and never stored; or,
   * when the Hub has no GitHub App (dev mode), with the host's own credentials.
   */
  Schema.TaggedStruct("CloneAccess", {
    credentials: Schema.Union([
      Schema.TaggedStruct("CloneToken", {
        token: Schema.RedactedFromValue(Schema.NonEmptyString),
        expiresAt: EpochMillis,
      }),
      Schema.TaggedStruct("HostCredentials", {}),
    ]).pipe(Schema.toTaggedUnion("_tag")),
  }),
  /** The Hub couldn't answer; `message` says why. */
  Schema.TaggedStruct("GitFailed", { message: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GitAnswer = typeof GitAnswer.Type

/** Hub to Runner: the answer to the GitRequest with the same `requestId`. */
export const GitReply = Schema.TaggedStruct("GitReply", {
  requestId: GitRequestId,
  answer: GitAnswer,
})
export type GitReply = typeof GitReply.Type

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
