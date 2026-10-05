// What hooks/register.ts uses, bundled with Effect and the protocol into hooks/hub-link-lib.js
// (`bun run build`). A hooks module can import only its own files and "claude-code", and the
// loader checks the hooks module's own source, so the glue stays hand-written beside this bundle
// (spike #4).

export type { FromSession, ModCommand, Participant, ToolCallOutcome } from "@claude-hub/protocol"
export { childReplyText, childToolPrefix, childToolRequest, childTools } from "./ChildTools.ts"
export { HubLink } from "./HubLink.ts"
export type { LinkStatus } from "./HubLink.ts"
export {
  clip,
  promptFromParticipant,
  resultSummary,
  sharedSessionNote,
  turnEndReason,
  turnUsage,
} from "./HubMessages.ts"
export { newCallId, ReadBeforeEdit, runInSandbox } from "./ToolBridgeClient.ts"
export type { BridgeExchange, ToolAnswer } from "./ToolBridgeClient.ts"
export { decideTool, startsShellMode, toolArguments } from "./ToolPolicy.ts"
