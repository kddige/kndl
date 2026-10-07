// The protocol's wire shapes: what goes over the socket as JSON, before decoding. The fake Hub
// keeps its data in these, as the real Hub's database would, so ids are plain strings.

import type {
  AgentSummary,
  AppPermissionsCheck,
  ClaudeCredentialInfo,
  CliTokenInfo,
  Environment,
  EnvironmentVersionInfo,
  HubToWeb,
  Member,
  OpenPort,
  Participant,
  PendingInvite,
  PendingPairingCode,
  PresentParticipant,
  Question,
  QuestionAnswer,
  QuestionPick,
  QueuedPrompt,
  RunnerSummary,
  SessionEvent,
  SessionLogEntry,
  SessionSummary,
  SharedVariable,
} from "@kndl/protocol"

export type HubMessage = (typeof HubToWeb)["Encoded"]
export type ParticipantWire = (typeof Participant)["Encoded"]
export type PresentParticipantWire = (typeof PresentParticipant)["Encoded"]
export type AgentSummaryWire = (typeof AgentSummary)["Encoded"]
export type SessionSummaryWire = (typeof SessionSummary)["Encoded"]
export type OpenPortWire = (typeof OpenPort)["Encoded"]
export type SessionEventWire = (typeof SessionEvent)["Encoded"]
export type LogEntryWire = (typeof SessionLogEntry)["Encoded"]
export type QueuedPromptWire = (typeof QueuedPrompt)["Encoded"]
export type RunnerSummaryWire = (typeof RunnerSummary)["Encoded"]
export type EnvironmentWire = (typeof Environment)["Encoded"]
export type EnvironmentVersionInfoWire = (typeof EnvironmentVersionInfo)["Encoded"]
export type SharedVariableWire = (typeof SharedVariable)["Encoded"]
export type AppPermissionsCheckWire = (typeof AppPermissionsCheck)["Encoded"]
export type PendingPairingCodeWire = (typeof PendingPairingCode)["Encoded"]
export type ClaudeCredentialInfoWire = (typeof ClaudeCredentialInfo)["Encoded"]
export type CliTokenInfoWire = (typeof CliTokenInfo)["Encoded"]
export type MemberWire = (typeof Member)["Encoded"]
export type PendingInviteWire = (typeof PendingInvite)["Encoded"]
export type QuestionWire = (typeof Question)["Encoded"]
export type QuestionAnswerWire = (typeof QuestionAnswer)["Encoded"]
export type QuestionPickWire = (typeof QuestionPick)["Encoded"]
