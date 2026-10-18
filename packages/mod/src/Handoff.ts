// A context handoff (ADR 0030), as both mods give it to their agent: the Hub's account of what
// happened in the Session while another Harness ran it, framed as context for the next prompt;
// and the tool that reads further back in the Session's history (`GET /mod/history`). The words
// are for any model, Claude's or another Provider's.

import { ModHistory } from "@kndl/protocol"
import type { DeliverHandoff, Harness } from "@kndl/protocol"
import { Exit, Schema } from "effect"

/** A Harness as the agent reads its name. */
const harnessName: Record<Harness, string> = { ClaudeCode: "Claude Code", Pi: "pi" }

/**
 * The handoff as the agent reads it, once, before the next prompt: the Hub's text, said to be
 * context and not a request, with where the Turns it left out are and the tool, `toolName`, that
 * reads them. Undefined when there's nothing to hand over.
 */
export const handoffNote = (
  handoff: Pick<DeliverHandoff, "from" | "text" | "earlierBefore">,
  toolName: string,
): string | undefined => {
  const text = handoff.text.trim()
  const { earlierBefore } = handoff
  if (text === "" && earlierBefore === undefined) return undefined
  return [
    "<context-handoff>",
    [
      `Until now this session ran on another agent harness, ${harnessName[handoff.from]}, maybe`,
      "on another model, and you are taking it over. Below is what happened in it that you haven't",
      "seen: the prompts people sent, the tools the agent called and what it answered, oldest first",
      "and shortened. Its reasoning, tool state and attached files didn't carry over. Read it as",
      "context for the next prompt, not a request of its own.",
    ].join(" "),
    earlierBefore === undefined
      ? `To read Turns from before it, call ${toolName}.`
      : `Turns before #${earlierBefore} were left out: if the next prompt needs them, call ${toolName} with before=${earlierBefore} to read them.`,
    ...(text === "" ? [] : ["", text]),
    "</context-handoff>",
  ].join("\n")
}

// ── The history tool ───────────────────────────────────────────────────────

/** The tool both mods register, by its short name: pi's name for it. */
export const historyTool = "session_history"

/** The tool as Claude calls it: Claude Code names a plugin's tools after the plugin. */
export const historyToolName = `mcp__hub-link-commands__${historyTool}`

/** How many Turns the tool reads when it isn't told, and the most it reads at once. */
export const DefaultHistoryLimit = 10
export const MaxHistoryLimit = 50

/** What the tool says of itself, for any model. */
export const historyToolDescription = [
  "Reads earlier Turns of this shared session from kndl, oldest first: who prompted each, the",
  "prompt, the tools the agent called and what it answered, shortened. A session can move between",
  "agent harnesses and models; when it moves to you, a <context-handoff> message tells you what",
  "happened that you haven't seen, and which Turns it left out. Call this when the prompt depends",
  "on something earlier than the handoff or your own conversation shows: pass `before` as the Turn",
  "number the handoff, or this tool's last answer, gives, to read the Turns before it. Without",
  "`before`, it reads the latest Turns.",
].join(" ")

/** The tool's input, as a JSON Schema: both arguments optional. */
export const historyInputSchema = {
  type: "object",
  properties: {
    before: {
      type: "integer",
      minimum: 0,
      description:
        "Read the Turns before this Turn number, as a <context-handoff> or this tool's last answer gives it. Leave it out to read the latest Turns.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MaxHistoryLimit,
      description: `How many Turns to read, at most ${MaxHistoryLimit}. ${DefaultHistoryLimit} when left out.`,
    },
  },
} as const

/** The tool, as Claude Code's `$.tool.register` takes it: in the tool list from the first request. */
export const historyToolSpec = {
  name: historyTool,
  description: historyToolDescription,
  inputSchema: historyInputSchema,
  isDeferred: false,
}

/** What the tool asks the Hub for. */
export interface HistoryRequest {
  readonly before?: number
  readonly limit: number
}

const wholeNumber = (value: unknown): number | undefined => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof number === "number" && Number.isInteger(number) ? number : undefined
}

/** Whether the model gave an argument: not left out, null or empty. */
const given = (value: unknown) => value !== undefined && value !== null && value !== ""

/**
 * The tool's arguments as a request to the Hub, read leniently, as models pass numbers as strings
 * and ask for more than they may: the limit is kept between 1 and {@link MaxHistoryLimit}.
 */
export const historyRequest = (
  input: Readonly<Record<string, unknown>>,
): HistoryRequest | { readonly error: string } => {
  const before = given(input.before) ? wholeNumber(input.before) : undefined
  if (given(input.before) && (before === undefined || before < 0))
    return { error: "`before` must be a Turn number, a whole number from 0 up." }
  const asked = given(input.limit) ? wholeNumber(input.limit) : DefaultHistoryLimit
  if (asked === undefined) return { error: "`limit` must be a whole number of Turns." }
  const limit = Math.min(MaxHistoryLimit, Math.max(1, asked))
  return before === undefined ? { limit } : { before, limit }
}

/** Where the tool reads the Turns `request` asks for, on the Hub. */
export const historyPath = (request: HistoryRequest) =>
  `/mod/history?${request.before === undefined ? "" : `before=${request.before}&`}limit=${request.limit}`

/** The Session's history as the agent reads it: each Turn, oldest first, then what's left. */
export const historyText = (
  history: ModHistory,
  request: HistoryRequest,
  toolName: string,
): string => {
  if (history.turns.length === 0)
    return request.before === undefined
      ? "This session has no Turns yet."
      : `There are no Turns before #${request.before}.`
  const turns = history.turns.map((turn) =>
    [
      `Turn #${turn.seq}, prompted by ${turn.by}${turn.model === undefined ? "" : `, on ${turn.model}`}`,
      `Prompt: ${turn.prompt}`,
      ...(turn.tools.length === 0
        ? []
        : ["Tools called:", ...turn.tools.map((call) => `- ${call}`)]),
      `Answer: ${turn.answer}`,
    ].join("\n"),
  )
  const rest =
    history.earlierBefore === undefined
      ? "This is the start of the session: there are no earlier Turns."
      : `There are earlier Turns: call ${toolName} with before=${history.earlierBefore} to read them.`
  return [...turns, rest].join("\n\n")
}

const decodeHistory = Schema.decodeUnknownExit(Schema.fromJsonString(ModHistory))

const failed = (why: string) => ({ error: `Could not read the session's history: ${why}` })

/** The tool's answer from the Hub's, to {@link historyPath}: the Turns as text, or why not. */
export const historyAnswer = (
  status: number,
  body: string,
  request: HistoryRequest,
  toolName: string,
): { readonly text: string } | { readonly error: string } => {
  if (status !== 200) {
    try {
      const { error } = JSON.parse(body) as { error?: unknown }
      if (typeof error === "string") return failed(error)
    } catch {
      // Said below.
    }
    return failed(`the Hub answered ${status}.`)
  }
  const history = decodeHistory(body)
  if (Exit.isFailure(history)) return failed("the Hub's answer was not one.")
  return { text: historyText(history.value, request, toolName) }
}
