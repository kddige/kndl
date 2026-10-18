// What each plugin's hooks/register.ts uses, bundled with Effect and the protocol into the
// plugin's hooks/hub-link-lib.js (`bun run build`). A hooks module can import only its own
// plugin's files and "claude-code", and the loader checks the hooks module's own source, so the
// glue stays hand-written beside this bundle (spike #4).

export type { ModCommand, Participant, QuestionAnswer, ToolCallOutcome } from "@kndl/protocol"
export {
  handoffNote,
  historyAnswer,
  historyPath,
  historyRequest,
  historyToolName,
  historyToolSpec,
} from "./Handoff.ts"
export { HubLink } from "./HubLink.ts"
export type { LinkStatus } from "./HubLink.ts"
export type { AnswerResult } from "./HubMessages.ts"
export {
  agentWorktree,
  answerResult,
  askedQuestions,
  attachmentContext,
  attachmentPart,
  attachmentPartPath,
  attachmentResult,
  attachmentToolName,
  attachmentToolSpec,
  backgroundedByStop,
  clip,
  deliveredPrompt,
  maxAttachmentParts,
  resultSummary,
  sharedSessionNote,
  startsDelivered,
  steeredPrompt,
  taskNotificationAgent,
  terminalOutcome,
  toolArguments,
  turnEndReason,
  turnUsage,
} from "./HubMessages.ts"
