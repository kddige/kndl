import { Schema } from "effect"
import { EventSeq, PromptId, RequestId, RunnerId, SessionId } from "./Ids.ts"
import {
  BranchName,
  EpochMillis,
  Participant,
  PresenceChanged,
  QueuedPrompt,
  RepoName,
  RunnerSummary,
  SessionState,
  SessionSummary,
  StopTurn,
} from "./Session.ts"
import { TerminalFrame, TerminalInput, TerminalResize } from "./Terminal.ts"
import { TurnEvent } from "./Turn.ts"
import { CurrentProtocolVersion, HandshakeRejected } from "./Version.ts"

// The Hub ↔ web channel. The browser connects with its sign-in cookie (issue #7), sends a
// WebHello, and waits for a WebWelcome or a HandshakeRejected. The Hub then sends the RunnerList
// and SessionList, and keeps them current.

// ── The Session event log ──────────────────────────────────────────────────

/** The Session moved to another lifecycle state. */
export const SessionStateChanged = Schema.TaggedStruct("SessionStateChanged", {
  state: SessionState,
  /** Who caused it, when a person did, such as by archiving. */
  by: Schema.optionalKey(Participant),
  /** Why, when it says more than the state, such as why a Session is Frozen. */
  message: Schema.optionalKey(Schema.String),
})
export type SessionStateChanged = typeof SessionStateChanged.Type

/** A Participant asked to stop the current Turn. */
export const TurnStopRequested = Schema.TaggedStruct("TurnStopRequested", {
  by: Participant,
})
export type TurnStopRequested = typeof TurnStopRequested.Type

/**
 * Everything a Session's history records: Turn events from the mod, and what the Hub saw
 * happen. New kinds of event are added here as members.
 */
export const SessionEvent = Schema.Union([TurnEvent, SessionStateChanged, TurnStopRequested]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type SessionEvent = typeof SessionEvent.Type

/** One entry of a Session's event log, numbered in the order the Hub appended it. */
export const SessionLogEntry = Schema.Struct({
  seq: EventSeq,
  at: EpochMillis,
  event: SessionEvent,
})
export type SessionLogEntry = typeof SessionLogEntry.Type

// ── web to Hub ─────────────────────────────────────────────────────────────

/** The web client's first message on every connection. */
export const WebHello = Schema.TaggedStruct("WebHello", {
  protocolVersion: CurrentProtocolVersion,
})
export type WebHello = typeof WebHello.Type

/** Start a new Session on a Repo, from a base branch. The Hub picks a Runner if none is named. */
export const CreateSession = Schema.TaggedStruct("CreateSession", {
  requestId: RequestId,
  repo: RepoName,
  baseBranch: BranchName,
  runnerId: Schema.optionalKey(RunnerId),
})
export type CreateSession = typeof CreateSession.Type

/**
 * Join a Session as a Participant: the Hub answers with its history, then sends its events,
 * presence and Prompt queue live until {@link LeaveSession}. On reconnect, `afterSeq` asks only
 * for the entries after the last one the client has.
 */
export const JoinSession = Schema.TaggedStruct("JoinSession", {
  sessionId: SessionId,
  afterSeq: Schema.optionalKey(EventSeq),
})
export type JoinSession = typeof JoinSession.Type

export const LeaveSession = Schema.TaggedStruct("LeaveSession", {
  sessionId: SessionId,
})
export type LeaveSession = typeof LeaveSession.Type

/** Add a prompt to the end of the Session's Prompt queue; the sender is the signed-in person. */
export const SendPrompt = Schema.TaggedStruct("SendPrompt", {
  sessionId: SessionId,
  text: Schema.NonEmptyString,
})
export type SendPrompt = typeof SendPrompt.Type

/** Remove a prompt from the Prompt queue before it is delivered. Any Participant may. */
export const CancelPrompt = Schema.TaggedStruct("CancelPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
})
export type CancelPrompt = typeof CancelPrompt.Type

/**
 * Put an Active Session to sleep now, rather than after it has been idle a while: its Claude
 * Code and Sandbox stop, and its next prompt wakes it. Refused while a Turn runs or prompts wait.
 */
export const SleepSession = Schema.TaggedStruct("SleepSession", {
  sessionId: SessionId,
})
export type SleepSession = typeof SleepSession.Type

/** Wake an Asleep Session without sending it a prompt. */
export const WakeSession = Schema.TaggedStruct("WakeSession", {
  sessionId: SessionId,
})
export type WakeSession = typeof WakeSession.Type

/** Start receiving the Session's terminal frames, beginning with a snapshot. */
export const OpenTerminal = Schema.TaggedStruct("OpenTerminal", {
  sessionId: SessionId,
})
export type OpenTerminal = typeof OpenTerminal.Type

export const CloseTerminal = Schema.TaggedStruct("CloseTerminal", {
  sessionId: SessionId,
})
export type CloseTerminal = typeof CloseTerminal.Type

/** Every message a web client sends the Hub. */
export const WebToHub = Schema.Union([
  WebHello,
  CreateSession,
  JoinSession,
  LeaveSession,
  SendPrompt,
  CancelPrompt,
  StopTurn,
  SleepSession,
  WakeSession,
  OpenTerminal,
  CloseTerminal,
  TerminalInput,
  TerminalResize,
]).pipe(Schema.toTaggedUnion("_tag"))
export type WebToHub = typeof WebToHub.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/** The Hub accepted the web client's hello. */
export const WebWelcome = Schema.TaggedStruct("WebWelcome", {
  protocolVersion: CurrentProtocolVersion,
  /** The signed-in person. */
  you: Participant,
})
export type WebWelcome = typeof WebWelcome.Type

/** Every Runner, in full: sent after the welcome and whenever one changes. */
export const RunnerList = Schema.TaggedStruct("RunnerList", {
  runners: Schema.Array(RunnerSummary),
})
export type RunnerList = typeof RunnerList.Type

/** Every Session the person can see, in full: sent after the welcome. */
export const SessionList = Schema.TaggedStruct("SessionList", {
  sessions: Schema.Array(SessionSummary),
})
export type SessionList = typeof SessionList.Type

/** A Session was created or changed; replaces the client's copy of it. */
export const SessionUpdated = Schema.TaggedStruct("SessionUpdated", {
  session: SessionSummary,
})
export type SessionUpdated = typeof SessionUpdated.Type

/** Answers a {@link CreateSession}. */
export const SessionCreated = Schema.TaggedStruct("SessionCreated", {
  requestId: RequestId,
  session: SessionSummary,
})
export type SessionCreated = typeof SessionCreated.Type

/** Answers a {@link JoinSession}: the log so far, or since `afterSeq`, oldest first. */
export const SessionHistory = Schema.TaggedStruct("SessionHistory", {
  sessionId: SessionId,
  entries: Schema.Array(SessionLogEntry),
})
export type SessionHistory = typeof SessionHistory.Type

/** An entry was appended to the log of a Session the client has joined. */
export const SessionEventLogged = Schema.TaggedStruct("SessionEventLogged", {
  sessionId: SessionId,
  entry: SessionLogEntry,
})
export type SessionEventLogged = typeof SessionEventLogged.Type

/** A joined Session's Prompt queue, in full and in order: sent on join and whenever it changes. */
export const PromptQueueChanged = Schema.TaggedStruct("PromptQueueChanged", {
  sessionId: SessionId,
  queue: Schema.Array(QueuedPrompt),
})
export type PromptQueueChanged = typeof PromptQueueChanged.Type

/**
 * A command was refused, such as a prompt to a Frozen Session. Names the command's `_tag`, and
 * its Session or request when it had one.
 */
export const CommandFailed = Schema.TaggedStruct("CommandFailed", {
  command: Schema.NonEmptyString,
  sessionId: Schema.optionalKey(SessionId),
  requestId: Schema.optionalKey(RequestId),
  message: Schema.String,
})
export type CommandFailed = typeof CommandFailed.Type

/** Every message the Hub sends a web client. */
export const HubToWeb = Schema.Union([
  WebWelcome,
  HandshakeRejected,
  RunnerList,
  SessionList,
  SessionUpdated,
  SessionCreated,
  SessionHistory,
  SessionEventLogged,
  PresenceChanged,
  PromptQueueChanged,
  TerminalFrame,
  CommandFailed,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubToWeb = typeof HubToWeb.Type
