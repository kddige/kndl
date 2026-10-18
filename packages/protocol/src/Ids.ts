import { Schema } from "effect"

// Branded ids, so a SessionId can't be passed where a RunnerId is expected. On the wire each is
// a plain string (EventSeq and ModCommandSeq numbers); the brand exists only in the decoded type.

/** A Session, minted by the Hub. */
export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/** A Runner, minted by the Hub when the Runner's token is issued. */
export const RunnerId = Schema.NonEmptyString.pipe(Schema.brand("RunnerId"))
export type RunnerId = typeof RunnerId.Type

/** A person who signs in to the Hub with GitHub, and so can be a Participant. */
export const ParticipantId = Schema.NonEmptyString.pipe(Schema.brand("ParticipantId"))
export type ParticipantId = typeof ParticipantId.Type

/** A Turn, as Claude Code's `turn.start` mints it. */
export const TurnId = Schema.NonEmptyString.pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

/** A prompt in a Session's Prompt queue, minted by the Hub. */
export const PromptId = Schema.NonEmptyString.pipe(Schema.brand("PromptId"))
export type PromptId = typeof PromptId.Type

/**
 * A file a Participant attached to a prompt (#276), minted by the Hub when it is uploaded: 128
 * random bits, since it is shown in the prompt and its file is cached for good.
 */
export const AttachmentId = Schema.NonEmptyString.pipe(Schema.brand("AttachmentId"))
export type AttachmentId = typeof AttachmentId.Type

/** One tool call: Claude Code's `tool_use_id`, or an id the mod mints when there is none. */
export const ToolCallId = Schema.NonEmptyString.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

/** A subagent's loop inside a Turn, as Claude Code's `agentId`. Absent on the main loop. */
export const AgentId = Schema.NonEmptyString.pipe(Schema.brand("AgentId"))
export type AgentId = typeof AgentId.Type

/**
 * A Session's conversation as its Harness names it, which the Harness takes back to resume it
 * when the Session wakes: Claude Code's session id, or pi's. The mod sends it from the Sandbox, and
 * the Runner names files on the host after it, so only a plain name decodes: never `../` or a path.
 */
export const ConversationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Schema.isMaxLength(128),
).pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

/** Chosen by a web client to match the Hub's answer to its request. */
export const RequestId = Schema.NonEmptyString.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

/** The position of an entry in a Session's event log: 0, 1, 2, ... in append order. */
export const EventSeq = Schema.Natural.pipe(Schema.brand("EventSeq"))
export type EventSeq = typeof EventSeq.Type

/** The position of a command in a Session's mod outbox: 1, 2, ... in the order it was queued. */
export const ModCommandSeq = Schema.Natural.pipe(Schema.brand("ModCommandSeq"))
export type ModCommandSeq = typeof ModCommandSeq.Type

/** A Test build of an Environment draft, minted by the Hub. */
export const TestBuildId = Schema.NonEmptyString.pipe(Schema.brand("TestBuildId"))
export type TestBuildId = typeof TestBuildId.Type

/** A Runner's request for variable values, minted by the Runner to match the Hub's answer. */
export const VariablesRequestId = Schema.NonEmptyString.pipe(Schema.brand("VariablesRequestId"))
export type VariablesRequestId = typeof VariablesRequestId.Type

/** An applied version of a Repo's Environment: 1, 2, ... in the order applied. */
export const EnvironmentVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("EnvironmentVersion"),
)
export type EnvironmentVersion = typeof EnvironmentVersion.Type

/** A Runner's request for a Session's Claude credential, minted by the Runner (ADR 0015). */
export const CredentialRequestId = Schema.NonEmptyString.pipe(Schema.brand("CredentialRequestId"))
export type CredentialRequestId = typeof CredentialRequestId.Type

/**
 * An MCP server (ADR 0020): a package's `package.json` name, or `hub:<slug>` for one made on this
 * Hub alone, which no npm name can be.
 */
export const McpServerId = Schema.NonEmptyString.pipe(Schema.brand("McpServerId"))
export type McpServerId = typeof McpServerId.Type

/** An Installation of an MCP server, minted by the Hub. */
export const InstallationId = Schema.NonEmptyString.pipe(Schema.brand("InstallationId"))
export type InstallationId = typeof InstallationId.Type
