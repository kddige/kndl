// Which tool calls hub-link lets through (ADR 0001). Claude Code runs on the Runner's host, but a
// Session's tools must never touch it: the file and command tools run in the Session's Sandbox,
// through the Runner's tool bridge, and every other tool is denied. The list is an allowlist, so
// a tool added to Claude Code later, an MCP tool, or a name nobody has heard of is denied too.

import { SandboxTools } from "@claude-hub/protocol"
import type { SandboxTool } from "@claude-hub/protocol"

/** What hub-link does with one tool call. */
export type ToolDecision =
  | { readonly _tag: "RunInSandbox"; readonly tool: SandboxTool }
  | { readonly _tag: "Deny"; readonly reason: string }

const sandboxTools: ReadonlySet<string> = new Set(SandboxTools)

const isSandboxTool = (tool: string): tool is SandboxTool => sandboxTools.has(tool)

/** The keys Claude Code adds to a tool call's input that the tool itself never sees. */
const reservedKeys: ReadonlySet<string> = new Set(["tool", "tool_use_id", "agentId", "consent"])

/** A tool call's own arguments, without the keys Claude Code adds beside them. */
export const toolArguments = (input: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([key]) => !reservedKeys.has(key)))

export const notAvailable = (tool: string) =>
  `${tool} is not available in this Claude Hub Session. Only ${SandboxTools.join(", ")} can be ` +
  "used here, and they run inside the Session's Sandbox."

export const noBackground =
  "Background commands are not available in this Claude Hub Session. Run the command in the " +
  "foreground instead."

/**
 * Decides one tool call: run it in the Sandbox, or deny it. `input` is the call's input as
 * Claude Code passed it.
 */
export const decideTool = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): ToolDecision => {
  if (!isSandboxTool(tool)) return { _tag: "Deny", reason: notAvailable(tool) }
  // A background command's output stays in the Sandbox, where Claude Code can't read it back
  // (spike #2). The launch flags turn background tasks off; this refuses one that slips through.
  if (tool === "Bash" && input["run_in_background"] === true)
    return { _tag: "Deny", reason: noBackground }
  return { _tag: "RunInSandbox", tool }
}

/**
 * Whether an edit to the prompt box would start Claude Code's `!` shell mode, which runs a
 * command on the host without a tool call (spike #2): a `!` typed or pasted at the start.
 */
export const startsShellMode = (edit: {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly inputText: string
}) => {
  const after = edit.text.slice(0, edit.start) + edit.inputText + edit.text.slice(edit.end)
  return after.startsWith("!")
}
