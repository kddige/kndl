// What each plugin's hooks/register.ts uses, bundled with Effect and the protocol into the
// plugin's hooks/hub-link-lib.js (`bun run build`). A hooks module can import only its own
// plugin's files and "claude-code", and the loader checks the hooks module's own source, so the
// glue stays hand-written beside this bundle (spike #4).

export type { ModCommand, Participant, ToolCallOutcome } from "@claude-hub/protocol"
export { HubLink } from "./HubLink.ts"
export type { LinkStatus } from "./HubLink.ts"
export {
  agentWorktree,
  backgroundedByStop,
  clip,
  promptFromParticipant,
  resultSummary,
  sharedSessionNote,
  startsDelivered,
  taskNotificationAgent,
  toolArguments,
  turnEndReason,
  turnUsage,
} from "./HubMessages.ts"
