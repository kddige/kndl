// The protocol's wire shapes: what goes over the socket as JSON, before decoding. The fake Hub
// keeps its data in these, as the real Hub's database would, so ids are plain strings.

import type {
  AgentSummary,
  Attachment,
  AppPermissionsCheck,
  BuildVersion,
  ClaudeCredentialInfo,
  CliTokenInfo,
  Environment,
  EnvironmentVersionInfo,
  HeaderValueSet,
  HubToWeb,
  HubUpdateRun,
  HubUpdateState,
  Installation,
  InstallationFailure,
  Member,
  OpenPort,
  ConnectedProvider,
  Participant,
  PendingInvite,
  ProviderModel,
  SignInStep,
  PendingPairingCode,
  McpServer,
  McpServerLogEntry,
  PresentParticipant,
  Question,
  QuestionAnswer,
  QuestionPick,
  QueuedPrompt,
  RunnerSummary,
  SessionEvent,
  SessionInstallation,
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
export type AttachmentWire = (typeof Attachment)["Encoded"]
export type RunnerSummaryWire = (typeof RunnerSummary)["Encoded"]
export type EnvironmentWire = (typeof Environment)["Encoded"]
export type EnvironmentVersionInfoWire = (typeof EnvironmentVersionInfo)["Encoded"]
export type SharedVariableWire = (typeof SharedVariable)["Encoded"]
export type AppPermissionsCheckWire = (typeof AppPermissionsCheck)["Encoded"]
export type BuildVersionWire = (typeof BuildVersion)["Encoded"]
export type HubUpdateStateWire = (typeof HubUpdateState)["Encoded"]
export type HubUpdateRunWire = (typeof HubUpdateRun)["Encoded"]
export type PendingPairingCodeWire = (typeof PendingPairingCode)["Encoded"]
export type ClaudeCredentialInfoWire = (typeof ClaudeCredentialInfo)["Encoded"]
export type CliTokenInfoWire = (typeof CliTokenInfo)["Encoded"]
export type MemberWire = (typeof Member)["Encoded"]
export type PendingInviteWire = (typeof PendingInvite)["Encoded"]
export type QuestionWire = (typeof Question)["Encoded"]
export type QuestionAnswerWire = (typeof QuestionAnswer)["Encoded"]
export type QuestionPickWire = (typeof QuestionPick)["Encoded"]
export type McpServerWire = (typeof McpServer)["Encoded"]
export type InstallationWire = (typeof Installation)["Encoded"]
export type HeaderValueSetWire = (typeof HeaderValueSet)["Encoded"]
export type McpServerLogEntryWire = (typeof McpServerLogEntry)["Encoded"]
export type SessionInstallationWire = (typeof SessionInstallation)["Encoded"]
export type InstallationFailureWire = (typeof InstallationFailure)["Encoded"]
export type ConnectedProviderWire = (typeof ConnectedProvider)["Encoded"]
export type ProviderModelWire = (typeof ProviderModel)["Encoded"]
export type SignInStepWire = (typeof SignInStep)["Encoded"]
