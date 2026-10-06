// What hooks/register.ts uses, bundled with Effect and the protocol into hooks/hub-link-lib.js
// (`bun run build`). A hooks module can import only its own files and "claude-code", and the
// loader checks the hooks module's own source, so the glue stays hand-written beside this bundle
// (spike #4).

export type { FromSession, ModCommand, Participant, ToolCallOutcome } from "@claude-hub/protocol"
export {
  childReplyText,
  childToolPrefix,
  childToolRequest,
  childTools,
  parentTools,
} from "./ChildTools.ts"
export type { ChildToolAnswer } from "./ChildTools.ts"
export { HubLink } from "./HubLink.ts"
export type { LinkStatus } from "./HubLink.ts"
export {
  clip,
  promptFromParticipant,
  resultSummary,
  sharedSessionNote,
  toolArguments,
  turnEndReason,
  turnUsage,
} from "./HubMessages.ts"
