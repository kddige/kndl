import { Schema } from "effect"

// The tool bridge: how the mod runs Claude Code's file and command tools in the Session's Sandbox
// (ADR 0001). The Runner keeps `claude mcp serve` running inside the Sandbox and serves it over
// HTTP on a per-Session Unix socket; Claude Code learns the socket's path from the
// `CLAUDE_HUB_TOOLS_SOCKET` environment variable.
//
// A call may run for longer than one HTTP exchange can last (Claude Code's `$.http.fetch` gives up
// after 30 seconds, and Bash allows up to 10 minutes), so the mod starts it and then waits for it
// in steps (#109):
//
// - `POST /tools/calls?waitMs=<ms>`, body ToolCallStart: starts the call under the mod's own
//   `callId`, then waits up to `waitMs` (at most MaxToolWaitMs) for it to end. Answered with a
//   ToolCallReply: the result if it ended, or `ToolRunning`. Starting a `callId` the bridge
//   already knows starts nothing: it waits for that call, so the mod may send it again after a
//   failed exchange.
// - `GET /tools/calls/<callId>?waitMs=<ms>`: waits up to `waitMs` for the call to end. Answered
//   with a ToolCallReply; `ToolLost` with 404 for a call the bridge doesn't know.
// - `DELETE /tools/calls/<callId>`: cancels the call, stopping what it runs in the Sandbox (the
//   bridge sends `notifications/cancelled`, and Claude Code's tool kills its process). Answered
//   with the call's result if it had already ended, else `ToolLost`.
//
// A call nothing has waited for in a while is cancelled too, as when Claude Code went away, and
// every running call is cancelled when the Session's Sandbox stops.
//
// Statuses: 200 for `ToolRan`, `ToolFailed` and `ToolLost`; 202 for `ToolRunning`; 503 for
// `BridgeUnavailable`; 404 for an unknown call; 400 for a body or query that doesn't decode.
//
// - `POST /tools/call`, body ToolBridgeCall: the single exchange the mod used before #109, kept
//   for mods loaded before their Runner was updated. It waits for the call to end and answers a
//   ToolBridgeReply; a call that ran but whose result was lost is answered as `ToolFailed`, with
//   a message saying it may have run.
//
// The mod must refuse the tool call whenever it doesn't get a `ToolRan` or `ToolFailed`: a
// failing hook lets Claude Code run the tool on the host (spike #2). It may say the tool did not
// run only when the bridge said so (`BridgeUnavailable`), or never accepted the call.

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

/** The id the mod gives a call it starts, which it waits for and cancels it by. */
export const BridgeCallId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/))
export type BridgeCallId = typeof BridgeCallId.Type

/** The body of `POST /tools/calls`: a call to start, under the mod's own id. */
export const ToolCallStart = Schema.Struct({
  callId: BridgeCallId,
  tool: Schema.Literals(SandboxTools),
  input: Schema.Record(Schema.String, Schema.Unknown),
})
export type ToolCallStart = typeof ToolCallStart.Type

/** The call is still running: wait again with `GET /tools/calls/<callId>`. */
export const ToolRunning = Schema.TaggedStruct("ToolRunning", { callId: BridgeCallId })
export type ToolRunning = typeof ToolRunning.Type

/**
 * The bridge sent the call to the Sandbox but has no result for it and never will: it was
 * cancelled, the tool server or the Sandbox stopped while it ran, or the bridge doesn't know the
 * call (it started again since). The tool may have run, wholly or in part.
 */
export const ToolLost = Schema.TaggedStruct("ToolLost", { message: Schema.String })
export type ToolLost = typeof ToolLost.Type

/** The answer to `POST /tools/calls`, `GET /tools/calls/<callId>` and `DELETE` of one. */
export const ToolCallReply = Schema.Union([
  ToolRan,
  ToolFailed,
  BridgeUnavailable,
  ToolRunning,
  ToolLost,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ToolCallReply = typeof ToolCallReply.Type
export type ToolCallReplyEncoded = typeof ToolCallReply.Encoded

/**
 * The longest the bridge holds `POST /tools/calls` or `GET /tools/calls/<callId>` open before it
 * answers `ToolRunning`: well inside the 30 seconds Claude Code's `$.http.fetch` waits.
 */
export const MaxToolWaitMs = 20_000

/** A whole number of at least zero, sent as a query parameter. */
const NaturalFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Natural))

/** The query of `POST /tools/calls` and `GET /tools/calls/<callId>`. No `waitMs` waits not at all. */
export const ToolWaitQuery = Schema.Struct({
  /** How long to wait for the call to end, in milliseconds. Above MaxToolWaitMs waits that long. */
  waitMs: Schema.optionalKey(NaturalFromString),
})
export type ToolWaitQuery = typeof ToolWaitQuery.Type
export type ToolWaitQueryEncoded = typeof ToolWaitQuery.Encoded
