// What the agent reads of the past, and how it leaves its own context behind:
//
// - `search_history(query)` searches every entry of its conversation, also those compaction
//   summarized and a handoff cleared away: Pi Durable keeps them all in storage.
// - `handoff(note)` hands the work off to itself: Pi Durable's handoff control starts a fresh
//   context from the note, and a follow-up queued with it (`kndl.continue`) carries the run on in
//   that context, with the Plan, which the Hub sees as the same Turn going on (Loops.ts).
// - `session_history` reads the Session's Turns from the Hub (ADR 0030), as the other Harnesses'
//   mods did: a Session that moved here from another Harness was handed what it hadn't seen
//   (`DeliverHandoff`), with where the Turns it left out are.

import type { Context } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import type { ConversationId, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable"
import { ModHistory } from "@kndl/protocol"
import type { DeliverHandoff, Harness as HubHarness } from "@kndl/protocol"
import { Exit, Schema } from "effect"
import { PlanDoc } from "./Docs.ts"
import type { Command } from "./hub/HubMessages.ts"
import { ContinueEntry, contentText, HandoffEntry } from "./Inputs.ts"
import { planText } from "./Plan.ts"
import type { Runtime } from "./Runtime.ts"

const searchHistoryTool = "search_history"
const handoffTool = "handoff"

/** The most entries one search reads, newest first. */
const MaxSearchedEntries = 20_000

/** What an entry says, as a search reads it: its messages' text and tool calls. */
const entrySearchText = (entry: EntryRecord): string =>
  (entry.model ?? [])
    .map((message) => {
      if (message.role === "assistant")
        return message.content
          .map((block) =>
            block.type === "text"
              ? block.text
              : block.type === "toolCall"
                ? `${block.name}(${JSON.stringify(block.arguments)})`
                : "",
          )
          .filter((text) => text !== "")
          .join("\n")
      if (message.role === "system") return ""
      return contentText(message.content)
    })
    .filter((text) => text !== "")
    .join("\n")

/** Who wrote an entry, for a search's answer. */
const roleOf = (entry: EntryRecord) => {
  if (entry.kind === "pi.compaction") return "summary"
  if (entry.kind === "pi.reset") return "handoff"
  const message = entry.model?.[0]
  if (message === undefined) return entry.kind
  if (message.role === "toolResult") return `result of ${message.toolName}`
  return message.role
}

/** The part of `text` around the first of `terms`, on one line. */
const snippet = (text: string, terms: ReadonlyArray<string>, width = 300) => {
  const lower = text.toLowerCase()
  const at = Math.max(
    0,
    Math.min(...terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0)),
  )
  const start = Math.max(0, at - Math.floor(width / 3))
  const piece = text
    .slice(start, start + width)
    .replace(/\s+/g, " ")
    .trim()
  return `${start > 0 ? "…" : ""}${piece}${start + width < text.length ? "…" : ""}`
}

/**
 * The entries of a conversation, newest first, whose text has every word of `query`, case aside;
 * before the entry `before`, when given.
 */
const searchEntries = async (
  harness: Harness,
  conversationId: ConversationId,
  query: string,
  options: { readonly limit: number; readonly before?: number | undefined },
  context: Context,
): Promise<{
  readonly found: Array<string>
  readonly searched: number
  readonly next?: EntryId
}> => {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
  const conversation = await harness.conversation(conversationId, context)
  if (conversation === undefined || terms.length === 0) return { found: [], searched: 0 }
  const found: Array<string> = []
  let searched = 0
  let cursor: Parameters<typeof conversation.entries>[2]
  for (;;) {
    const page = await conversation.entries(
      options.before === undefined ? {} : { maxEntryId: (options.before - 1) as EntryId },
      200,
      cursor,
      context,
    )
    for (const entry of page.items) {
      searched++
      const text = entrySearchText(entry)
      const lower = text.toLowerCase()
      if (terms.every((term) => lower.includes(term)))
        found.push(`#${entry.id} ${roleOf(entry)}: ${snippet(text, terms)}`)
      if (found.length >= options.limit) return { found, searched, next: entry.id }
      if (searched >= MaxSearchedEntries) return { found, searched, next: entry.id }
    }
    if (page.next === undefined) return { found, searched }
    cursor = page.next
  }
}

/** The search tool. */
export const searchHistoryToolDefinition = (runtime: Runtime) =>
  defineTool({
    name: searchHistoryTool,
    description:
      "Searches everything said in this conversation, newest first: prompts, your answers, your tool calls and their results, also what was summarized away or handed off. Returns each matching entry's number and the text around the match. Use it to find a detail you no longer have in context.",
    parameters: Type.Object({
      query: Type.String({ description: "Words that must all appear, case aside." }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "How many matches, 10 by default." }),
      ),
      before: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Search entries before this entry number, to page through older matches.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { found, searched, next } = await searchEntries(
        runtime.harness(),
        api.conversationId,
        args.query,
        { limit: args.limit ?? 10, before: args.before },
        context,
      )
      const more =
        next === undefined
          ? `Searched all ${searched} entries.`
          : `Searched ${searched} entries; for older matches, search again with before=${next}.`
      return {
        output: [
          {
            type: "text",
            text: found.length === 0 ? `Nothing matches. ${more}` : [...found, more].join("\n\n"),
          },
        ],
      }
    },
  })

/** What the model reads as its run goes on after it handed off to itself. */
const continueText = [
  "Continue the work from your handoff note above, in this fresh context.",
  `Everything before it is still searchable with ${searchHistoryTool}.`,
].join(" ")

/**
 * The handoff tool. Replay-safe: a rerun queues the same follow-up, by its request id, and asks
 * for the same handoff.
 */
export const handoffToolDefinition = () =>
  defineTool({
    name: handoffTool,
    description: [
      "Hands your work off to yourself, in a fresh context: everything you have seen so far is replaced by the note you write, and you carry on from it at once, in the same turn.",
      "Use it when a long task has filled your context with detail you no longer need, before it is summarized for you: you decide what carries over.",
      "Write the note for someone who knows nothing of this conversation: the goal and who asked, what is done and how you checked it, what is left, the plan, the files and commands that matter, and anything you were told to keep in mind. The old context stays searchable with search_history.",
    ].join(" "),
    parameters: Type.Object({
      note: Type.String({ description: "Everything the next stretch of work needs." }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const note = args.note.trim()
      if (note === "") throw new Error("Write the note: it is all your next context starts with.")
      // The Plan was in the context the handoff clears: it carries over with the note.
      const plan = planText(await api.snapshot(PlanDoc, api.conversationId, context))
      const conversation = await api.conversation(api.conversationId, context)
      await conversation?.submit(
        {
          type: "input",
          content: plan === undefined ? continueText : `${continueText}\n\n${plan}`,
          whenBusy: "followUp",
          requestId: `continue:${api.callId}`,
          entry: { kind: ContinueEntry, data: {} },
        },
        context,
      )
      return {
        output: [{ type: "text", text: "Handing off: you continue from your note." }],
        control: { handoff: `<handoff-note>\n${note}\n</handoff-note>` },
      }
    },
  })

// ── What the Hub hands over of the Session's earlier Turns ──────────────────

/** A Harness as the agent reads its name. */
const harnessName: Record<HubHarness, string> = { ClaudeCode: "Claude Code", Pi: "pi" }

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

/** The history tool's name. */
const historyTool = "session_history"

/** How many Turns the tool reads when it isn't told, and the most it reads at once. */
const DefaultHistoryLimit = 10
const MaxHistoryLimit = 50

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

/** What the tool asks the Hub for. */
interface HistoryRequest {
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

/** The history tool: the Session's earlier Turns, from the Hub, as text. */
export const sessionHistoryToolDefinition = (runtime: Runtime) =>
  defineTool({
    name: historyTool,
    description: historyToolDescription,
    parameters: Type.Object({
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
    }),
    replay: "safe",
    execute: async (args, _api, context) => {
      const request = historyRequest(args)
      if ("error" in request) throw new Error(request.error)
      let response: { readonly status: number; readonly text: string }
      try {
        response = await runtime.hubGet(historyPath(request), context.abortSignal)
      } catch (error) {
        throw new Error(`Could not read the session's history: ${String(error)}`, { cause: error })
      }
      const answer = historyAnswer(response.status, response.text, request, historyTool)
      if ("error" in answer) throw new Error(answer.error)
      return { output: [{ type: "text", text: answer.text }] }
    },
  })

/**
 * A context handoff from another Harness (ADR 0030): a note the model reads ahead of the next
 * prompt, as an entry of its own. It changes what the model sees, so it is placed at the next
 * boundary, or at once while the main loop is idle.
 */
export const deliverHandoff = async (runtime: Runtime, command: Command<"DeliverHandoff">) => {
  const note = handoffNote(command, historyTool)
  if (note === undefined) return
  const root = await runtime.harness().root(runtime.context)
  await root.submit(
    {
      type: "write",
      entry: {
        kind: HandoffEntry,
        data: { from: command.from },
        model: [{ role: "user", content: note, timestamp: Date.now() }],
      },
    },
    runtime.context,
  )
}
