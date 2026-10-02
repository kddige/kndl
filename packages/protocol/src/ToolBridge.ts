import { Schema } from "effect"

// The tool bridge: how the mod runs Claude Code's file and command tools in the Session's Sandbox
// (ADR 0001). The Runner keeps `claude mcp serve` running inside the Sandbox and serves it over
// HTTP on a per-Session Unix socket; Claude Code learns the socket's path from the
// `CLAUDE_HUB_TOOLS_SOCKET` environment variable.
//
// - `POST /tools/call`, body ToolBridgeCall: answered with a ToolBridgeReply. 200 for
//   `ToolRan` and `ToolFailed`; 503 for `BridgeUnavailable`; 400 for a body that doesn't decode.
//
// The mod must refuse the tool call whenever it doesn't get a `ToolRan` or `ToolFailed`: a
// failing hook lets Claude Code run the tool on the host (spike #2).

/** The environment variable that tells the mod where the Session's tool bridge listens. */
export const ToolsSocketVariable = "CLAUDE_HUB_TOOLS_SOCKET"

/** The tools the bridge runs in the Sandbox: Claude Code's file and command tools (ADR 0001). */
export const SandboxTools = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
] as const
export type SandboxTool = (typeof SandboxTools)[number]

/** One tool call, with the tool's own arguments as Claude Code passed them. */
export const ToolBridgeCall = Schema.Struct({
  tool: Schema.Literals(SandboxTools),
  input: Schema.Record(Schema.String, Schema.Unknown),
})
export type ToolBridgeCall = typeof ToolBridgeCall.Type

/**
 * The tool ran. `result` is the tool's own record (Claude Code's output shape for that tool),
 * which the mod hands back to Claude Code as the call's result.
 */
export const ToolRan = Schema.TaggedStruct("ToolRan", { result: Schema.Unknown })
export type ToolRan = typeof ToolRan.Type

/**
 * The tool ran and reported an error, such as a command that exited non-zero or a file that
 * doesn't exist. `message` is the text the model should read.
 */
export const ToolFailed = Schema.TaggedStruct("ToolFailed", { message: Schema.String })
export type ToolFailed = typeof ToolFailed.Type

/** The bridge couldn't run the tool: the Sandbox or its tool server is down or misbehaving. */
export const BridgeUnavailable = Schema.TaggedStruct("BridgeUnavailable", {
  message: Schema.String,
})
export type BridgeUnavailable = typeof BridgeUnavailable.Type

/** The answer to `POST /tools/call`. */
export const ToolBridgeReply = Schema.Union([ToolRan, ToolFailed, BridgeUnavailable]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type ToolBridgeReply = typeof ToolBridgeReply.Type
export type ToolBridgeReplyEncoded = typeof ToolBridgeReply.Encoded
