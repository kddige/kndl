// The protocol's wire shapes: what goes over the socket as JSON, before decoding. The fake Hub
// keeps its data in these, as the real Hub's database would, so ids are plain strings.

import type {
  HubToWeb,
  Participant,
  QueuedPrompt,
  RunnerSummary,
  SessionEvent,
  SessionLogEntry,
  SessionSummary,
} from "@claude-hub/protocol"

export type HubMessage = (typeof HubToWeb)["Encoded"]
export type ParticipantWire = (typeof Participant)["Encoded"]
export type SessionSummaryWire = (typeof SessionSummary)["Encoded"]
export type SessionEventWire = (typeof SessionEvent)["Encoded"]
export type LogEntryWire = (typeof SessionLogEntry)["Encoded"]
export type QueuedPromptWire = (typeof QueuedPrompt)["Encoded"]
export type RunnerSummaryWire = (typeof RunnerSummary)["Encoded"]
