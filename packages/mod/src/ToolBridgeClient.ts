// Runs a tool call in the Session's Sandbox through the Runner's tool bridge (see the protocol's
// ToolBridge.ts), and turns the bridge's reply into what the mod answers Claude Code with.
//
// It fails closed: unless the bridge answers with a well-formed ToolRan or ToolFailed, the call
// is refused. A hook that throws or passes the call on lets Claude Code run the tool on the host
// (spike #2), so nothing here throws and nothing calls `next`.

import { ToolBridgeReply } from "@claude-hub/protocol"
import type { SandboxTool } from "@claude-hub/protocol"
import { Exit, Schema } from "effect"

/** One HTTP exchange with the bridge: POSTs `body` to `/tools/call` on the bridge's socket. */
export type BridgePost = (
  socketPath: string,
  body: string,
) => Promise<{ readonly status: number; readonly text: string }>

/** How a tool call went. */
export type ToolAnswer =
  /** The tool ran in the Sandbox; `result` is its own record, for Claude Code. */
  | { readonly _tag: "Ran"; readonly result: unknown }
  /** The tool ran in the Sandbox and reported an error; the model reads `message`. */
  | { readonly _tag: "Failed"; readonly message: string }
  /** The tool did not run anywhere: the bridge was missing, down, or answered nonsense. */
  | { readonly _tag: "Refused"; readonly message: string }

const decodeReply = Schema.decodeUnknownExit(Schema.fromJsonString(ToolBridgeReply))

export const refusal = (tool: string, why: string) =>
  `${tool} could not run in this Session's Sandbox (${why}), so it did not run at all. ` +
  "It never runs on the host."

/** Runs one tool call in the Sandbox. Never throws. */
export const runInSandbox = async (
  post: BridgePost,
  socketPath: string | undefined,
  tool: SandboxTool,
  input: Readonly<Record<string, unknown>>,
): Promise<ToolAnswer> => {
  if (socketPath === undefined || socketPath === "")
    return { _tag: "Refused", message: refusal(tool, "this Session has no tool bridge") }
  let response: { readonly status: number; readonly text: string }
  try {
    response = await post(socketPath, JSON.stringify({ tool, input }))
  } catch (error) {
    return { _tag: "Refused", message: refusal(tool, `the tool bridge is unreachable: ${error}`) }
  }
  const reply = decodeReply(response.text)
  if (Exit.isFailure(reply))
    return {
      _tag: "Refused",
      message: refusal(tool, `the tool bridge answered ${response.status} with no tool reply`),
    }
  switch (reply.value._tag) {
    case "ToolRan":
      return response.status === 200
        ? { _tag: "Ran", result: reply.value.result }
        : { _tag: "Refused", message: refusal(tool, `the tool bridge answered ${response.status}`) }
    case "ToolFailed":
      return { _tag: "Failed", message: reply.value.message }
    case "BridgeUnavailable":
      return { _tag: "Refused", message: refusal(tool, reply.value.message) }
  }
}

/**
 * Claude Code's rule that a file must be read before it is edited. Core checks it before a tool
 * runs, which a hook that answers the call skips, and `claude mcp serve` doesn't check it either
 * (spike #2), so the mod keeps it: the paths read or written since the mod loaded.
 */
export class ReadBeforeEdit {
  private readonly known = new Set<string>()

  /** The reason to refuse an edit of a file not read yet, or undefined to let it run. */
  check(tool: SandboxTool, input: Readonly<Record<string, unknown>>): string | undefined {
    if (tool !== "Edit" && tool !== "NotebookEdit") return undefined
    const path = input["file_path"] ?? input["notebook_path"]
    if (typeof path !== "string" || this.known.has(path)) return undefined
    return "File has not been read yet. Read it first before writing to it."
  }

  /** Notes the file a tool that ran read or wrote. */
  record(tool: SandboxTool, input: Readonly<Record<string, unknown>>, result: unknown) {
    if (tool === "Bash") return
    const record = (result ?? {}) as {
      filePath?: unknown
      file?: { filePath?: unknown }
      notebook_path?: unknown
    }
    for (const path of [
      record.filePath,
      record.file?.filePath,
      record.notebook_path,
      input["file_path"],
      input["notebook_path"],
    ])
      if (typeof path === "string") this.known.add(path)
  }
}
