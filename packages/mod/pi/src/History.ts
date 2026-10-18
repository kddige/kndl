// A context handoff in a pi Session (ADR 0030): after the Session switched to pi from Claude Code,
// the Hub's account of what happened meanwhile is a custom message pi sends the model with the
// next request, ahead of the prompt, drawn as one line in pi's terminal; and the history tool
// reads further back, as hub-link-commands' does in Claude Code.

import { Type } from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI, MessageRenderer, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { DeliverHandoff, Harness } from "@kndl/protocol"
import {
  handoffNote,
  harnessName,
  historyAnswer,
  historyInputSchema,
  historyPath,
  historyRequest,
  historyTool,
  historyToolDescription,
} from "../../src/Handoff.ts"

/** The custom message a handoff is. */
export const handoffMessage = "kndl-handoff"

/** What the handoff's message keeps beside its text, for its line in the terminal. */
export interface HandoffDetails {
  readonly from: Harness
  readonly earlierBefore?: number
}

export interface HistoryDeps {
  /** GETs a path on the Hub, with the mod token, until `signal` (the call's) aborts. */
  readonly fetchHistory: (
    path: string,
    signal: AbortSignal | undefined,
  ) => Promise<{ readonly status: number; readonly text: string }>
}

const historyParameters = Type.Object({
  before: Type.Optional(
    Type.Integer({ minimum: 0, description: historyInputSchema.properties.before.description }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: historyInputSchema.properties.limit.maximum,
      description: historyInputSchema.properties.limit.description,
    }),
  ),
})

/** The history tool: the Session's earlier Turns, from the Hub, as text. */
export const historyToolDefinition = (
  deps: HistoryDeps,
): ToolDefinition<typeof historyParameters, undefined> => ({
  name: historyTool,
  label: "Session history",
  description: historyToolDescription,
  promptSnippet: "Read earlier Turns of this shared session, before a Turn number",
  parameters: historyParameters,
  execute: async (_toolCallId, params, signal) => {
    const request = historyRequest(params)
    if ("error" in request) throw new Error(request.error)
    let response: { readonly status: number; readonly text: string }
    try {
      response = await deps.fetchHistory(historyPath(request), signal)
    } catch (error) {
      throw new Error(`Could not read the session's history: ${String(error)}`, { cause: error })
    }
    const answer = historyAnswer(response.status, response.text, request, historyTool)
    if ("error" in answer) throw new Error(answer.error)
    return { content: [{ type: "text", text: answer.text }], details: undefined }
  },
})

/** `text` cut to `width` characters, with an ellipsis when it was cut. */
const cut = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

/** `line` in pieces of at most `width` characters. */
const wrap = (line: string, width: number): Array<string> => {
  if (line === "") return [""]
  const pieces: Array<string> = []
  for (let at = 0; at < line.length; at += Math.max(1, width))
    pieces.push(line.slice(at, at + width))
  return pieces
}

/**
 * A handoff in pi's terminal: one line saying what it is, or, expanded, the whole of what the
 * model reads.
 */
export const renderHandoff: MessageRenderer<HandoffDetails> = (message, options, theme) => {
  const from = message.details?.from
  const earlier = message.details?.earlierBefore
  const header = [
    `kndl: context handoff${from === undefined ? "" : ` from ${harnessName[from]}`}, for the next prompt`,
    earlier === undefined ? "" : ` (Turns before #${earlier} left out)`,
  ].join("")
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
  const pad = " ".repeat(options.outputPad)
  return {
    render: (width) => {
      const room = Math.max(1, width - options.outputPad)
      const line = `${pad}${theme.fg("customMessageLabel", cut(header, room))}`
      if (!options.expanded) return [line]
      return [
        line,
        ...text
          .split("\n")
          .flatMap((each) => wrap(each, room))
          .map((each) => (each === "" ? "" : `${pad}${theme.fg("muted", each)}`)),
      ]
    },
    invalidate: () => undefined,
  }
}

/**
 * Registers the history tool and how a handoff is drawn; `deliver` gives the model a handoff the
 * Hub sent. pi adds it to the conversation at once while idle, starting no run, so the next
 * prompt's request carries it ahead of the prompt; during a run, at the run's end.
 */
export const registerHistory = (pi: ExtensionAPI, deps: HistoryDeps) => {
  pi.registerTool(historyToolDefinition(deps))
  pi.registerMessageRenderer(handoffMessage, renderHandoff)
  return {
    deliver: (command: DeliverHandoff) => {
      const content = handoffNote(command, historyTool)
      if (content === undefined) return
      const details: HandoffDetails = {
        from: command.from,
        ...(command.earlierBefore === undefined ? {} : { earlierBefore: command.earlierBefore }),
      }
      pi.sendMessage<HandoffDetails>({
        customType: handoffMessage,
        content,
        display: true,
        details,
      })
    },
  }
}
