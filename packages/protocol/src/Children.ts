import { Schema } from "effect"
import { SessionId } from "./Ids.ts"
import { BranchName, EpochMillis, SessionName, SessionRef, SessionState } from "./Session.ts"

// The Child Session tools (ADR 0012), over the mod's channel: a Parent Session's Claude Code calls
// them as mod tools, and its mod asks the Hub with `POST /mod/children`, the body a ChildRequest,
// with the Session's mod token. The Hub answers 200 with a ChildReply: ChildRefused when it won't,
// as for a Child Session asking (one level deep), or a Session that isn't the caller's child.
// Like the rest of the mod channel, it answers 409 until the mod has said hello.
//
// A Child Session runs in its Parent Session's Repo, for its Creator, on a Runner the Hub picks.
// Its final message of every Turn reaches the Parent Session as a Report, a queued prompt. Its one
// tool, message_parent, asks with MessageParent: a message to its parent mid-Turn, queued the same
// way. The Hub refuses MessageParent from a Session that isn't a Child Session.

/**
 * How many exchanges in a row a Parent and Child Session may have, with no person's prompt to
 * either, before each Report reminds the parent to check it is still making progress. An
 * exchange is a Turn of the child that the parent prompted, which ends in a Report. A note only:
 * nothing is stopped.
 */
export const LoopGuardExchanges = 20

/** Start a Child Session on a task. */
export const CreateChild = Schema.TaggedStruct("CreateChild", {
  /** The task: the Child Session's first prompt. */
  prompt: Schema.NonEmptyString,
  /** Its Session name; without one it is shown by its Work branch. */
  name: Schema.optionalKey(SessionName),
  /** The branch it starts from; the Repo's default branch by default. */
  baseBranch: Schema.optionalKey(BranchName),
})
export type CreateChild = typeof CreateChild.Type

/** Queue a prompt for one of the caller's Child Sessions, waking it if it is Asleep. */
export const MessageChild = Schema.TaggedStruct("MessageChild", {
  childId: SessionId,
  text: Schema.NonEmptyString,
})
export type MessageChild = typeof MessageChild.Type

/** The caller's Child Sessions that aren't Archived, with what each is doing. */
export const ListChildren = Schema.TaggedStruct("ListChildren", {})
export type ListChildren = typeof ListChildren.Type

/** One of the caller's Child Sessions, with its recent conversation. */
export const ReadChild = Schema.TaggedStruct("ReadChild", { childId: SessionId })
export type ReadChild = typeof ReadChild.Type

/** Archive one of the caller's Child Sessions, as deleting it from the web UI does. */
export const ArchiveChild = Schema.TaggedStruct("ArchiveChild", { childId: SessionId })
export type ArchiveChild = typeof ArchiveChild.Type

/**
 * A Child Session's message to its Parent Session, mid-Turn: queued there as a prompt, waking it
 * if it is Asleep. Unlike a Report, it doesn't count as an exchange for the loop guard.
 */
export const MessageParent = Schema.TaggedStruct("MessageParent", { text: Schema.NonEmptyString })
export type MessageParent = typeof MessageParent.Type

/** The body of `POST /mod/children`. */
export const ChildRequest = Schema.Union([
  CreateChild,
  MessageChild,
  ListChildren,
  ReadChild,
  ArchiveChild,
  MessageParent,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ChildRequest = typeof ChildRequest.Type
export type ChildRequestEncoded = typeof ChildRequest.Encoded

/** A Child Session's last Report: its final message of a Turn, and when the Turn ended. */
export const ChildReport = Schema.Struct({ text: Schema.String, at: EpochMillis })
export type ChildReport = typeof ChildReport.Type

/** A Child Session as its Parent Session's tools show it. */
export const ChildSummary = Schema.Struct({
  id: SessionId,
  /** Its Session name, or its Work branch while it has none. */
  title: Schema.NonEmptyString,
  baseBranch: BranchName,
  workBranch: BranchName,
  state: SessionState,
  /** Whether a Turn is running, or its Claude Code is starting with prompts to deliver. */
  working: Schema.Boolean,
  /** The prompts waiting in its Prompt queue. */
  queued: Schema.Natural,
  /** Absent until its first Turn ends. */
  lastReport: Schema.optionalKey(ChildReport),
})
export type ChildSummary = typeof ChildSummary.Type

/** The Child Session was created and is starting; its task is queued as its first prompt. */
export const ChildCreated = Schema.TaggedStruct("ChildCreated", { child: ChildSummary })
export type ChildCreated = typeof ChildCreated.Type

/** The message was queued for the Child Session. */
export const ChildMessaged = Schema.TaggedStruct("ChildMessaged", { child: ChildSummary })
export type ChildMessaged = typeof ChildMessaged.Type

/** The caller's Child Sessions that aren't Archived, oldest first. */
export const ChildList = Schema.TaggedStruct("ChildList", { children: Schema.Array(ChildSummary) })
export type ChildList = typeof ChildList.Type

/** A Child Session and its recent conversation, redacted as its history is. */
export const ChildRead = Schema.TaggedStruct("ChildRead", {
  child: ChildSummary,
  /** Its last Turns as text: prompts, Claude's text, and tool calls by name. */
  conversation: Schema.String,
})
export type ChildRead = typeof ChildRead.Type

/** The Child Session was archived. */
export const ChildArchived = Schema.TaggedStruct("ChildArchived", { child: ChildSummary })
export type ChildArchived = typeof ChildArchived.Type

/** The message was queued for the caller's Parent Session. */
export const ParentMessaged = Schema.TaggedStruct("ParentMessaged", {
  parent: SessionRef,
  /** Whether a Turn of the parent is running, so it reads the message once that Turn ends. */
  working: Schema.Boolean,
})
export type ParentMessaged = typeof ParentMessaged.Type

/** The request was refused, and why. */
export const ChildRefused = Schema.TaggedStruct("ChildRefused", { message: Schema.String })
export type ChildRefused = typeof ChildRefused.Type

/** The answer to `POST /mod/children`. */
export const ChildReply = Schema.Union([
  ChildCreated,
  ChildMessaged,
  ChildList,
  ChildRead,
  ChildArchived,
  ParentMessaged,
  ChildRefused,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ChildReply = typeof ChildReply.Type
export type ChildReplyEncoded = typeof ChildReply.Encoded
