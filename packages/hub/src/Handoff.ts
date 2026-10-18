// What a Session's agent is told of the Session's history (ADR 0030), built from its log alone:
//
// - Its Turns: each Turn on the main loop, from its TurnStarted, as who prompted it and what, the
//   tools its agent called (`tool: input`), what it answered (its TextDeltas joined, what it said
//   either side of a tool call apart) and the model it ran on, each clipped. A subagent's work
//   isn't its own. `GET /mod/history` serves them a page at a time.
// - The context handoff: after a switch of Harness, the Turns the new Harness hasn't seen, and the
//   model switches among them, in kndl's voice, oldest first, kept within a budget: the newest
//   that fit, and where the earlier ones start, for the agent to read with its history tool. The
//   log is read back from its end only as far as that takes.

import {
  type EventSeq,
  type Harness,
  type HistoryTurn,
  type ModHistory,
  type PromptSender,
  type SessionLogEntry,
  type TurnEndReason,
} from "@kndl/protocol"
import { Effect } from "effect"

/** The longest prompt or answer a Turn is told with, in characters. */
export const MaxTurnTextLength = 4_000
/** The longest tool call a Turn is told with, `tool: input`, in characters. */
export const MaxToolCallLength = 200
/** The most tool calls a Turn is told with; the rest are counted. */
export const MaxToolCalls = 30
/** The longest handoff, in characters: about 16,000 tokens. */
export const HandoffBudget = 64_000
/** How many Turns a handoff's history is read back from the end at a time, until it is full. */
export const HandoffReadTurns = 50
/** The Turns `GET /mod/history` gives when not asked for a number, and the most it gives. */
export const DefaultHistoryLimit = 20
export const MaxHistoryLimit = 50

const harnessNames: Readonly<Record<Harness, string>> = { ClaudeCode: "Claude Code", Pi: "pi" }

/** The text, clipped to `max` characters, saying how many more there were. */
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`

/** Who prompted a Turn, as the agent is told. */
const promptedBy = (sender: PromptSender) => {
  switch (sender._tag) {
    case "FromParticipant":
      return sender.participant.name
    case "FromTerminal":
      return "the terminal"
    case "FromAgent":
      return `subagent ${sender.agentId}`
    case "FromSession":
      return "another Session"
  }
}

/** A Turn as the log has it, before it is clipped. */
interface LoggedTurn {
  readonly seq: EventSeq
  readonly at: number
  readonly sender: PromptSender
  prompt: string
  readonly tools: Array<string>
  answer: string
  /** Whether the agent called a tool since it last said something: what it says next is apart. */
  calledTool: boolean
  model?: string
  ended?: { readonly reason: TurnEndReason; readonly errorMessage?: string }
}

/** Something else the handoff tells: a model switch. */
interface Note {
  readonly seq: EventSeq
  readonly at: number
  readonly text: string
}

/** The main loop's Turns of the entries, and the notes among them, oldest first. */
const readLog = (entries: ReadonlyArray<SessionLogEntry>) => {
  const turns: Array<LoggedTurn> = []
  const notes: Array<Note> = []
  const byId = new Map<string, LoggedTurn>()
  for (const { seq, at, event } of entries) {
    // A subagent's work is its own.
    if ("agentId" in event && event.agentId !== undefined) continue
    switch (event._tag) {
      case "TurnStarted": {
        const files = event.attachments?.length ?? 0
        const turn: LoggedTurn = {
          seq,
          at,
          sender: event.sender,
          prompt:
            files === 0
              ? event.text
              : `${event.text}\n(${files === 1 ? "1 attachment" : `${files} attachments`}, not carried over)`,
          tools: [],
          answer: "",
          calledTool: false,
        }
        turns.push(turn)
        byId.set(event.turnId, turn)
        break
      }
      case "PromptSteered": {
        const turn = byId.get(event.turnId)
        if (turn !== undefined) {
          turn.prompt += `\n\n${event.sender.name} added, while it ran: ${event.text}`
        }
        break
      }
      case "ToolCallStarted": {
        const turn = byId.get(event.turnId)
        if (turn === undefined) break
        turn.tools.push(`${event.tool}: ${event.input}`)
        turn.calledTool = true
        break
      }
      case "TextDelta": {
        const turn = byId.get(event.turnId)
        if (turn === undefined) break
        // What it said before a tool call and after it are apart, as the transcript shows them.
        if (turn.calledTool && turn.answer !== "") turn.answer += "\n\n"
        turn.calledTool = false
        turn.answer += event.text
        break
      }
      case "TurnEnded": {
        const turn = byId.get(event.turnId)
        if (turn === undefined) break
        turn.ended = {
          reason: event.reason,
          ...(event.errorMessage !== undefined && { errorMessage: event.errorMessage }),
        }
        if (event.usage !== undefined) turn.model = event.usage.model
        break
      }
      case "ModelSwitched": {
        const model = event.modelLabel ?? event.model ?? "the default model"
        const on = event.harness === undefined ? "" : `, on ${harnessNames[event.harness]}`
        notes.push({ seq, at, text: `${event.by.name} switched the model to ${model}${on}.` })
        break
      }
      default:
        break
    }
  }
  return { turns, notes }
}

/** The tool calls of a Turn, clipped, the ones past the most counted. */
const toolsOf = (turn: LoggedTurn) => {
  const shown = turn.tools.slice(0, MaxToolCalls).map((call) => clip(call, MaxToolCallLength))
  const more = turn.tools.length - shown.length
  return more > 0 ? [...shown, `… and ${more} more`] : shown
}

const historyTurn = (turn: LoggedTurn): HistoryTurn => ({
  seq: turn.seq,
  by: promptedBy(turn.sender),
  prompt: clip(turn.prompt, MaxTurnTextLength),
  tools: toolsOf(turn),
  answer: clip(turn.answer, MaxTurnTextLength),
  ...(turn.model !== undefined && { model: turn.model }),
})

/** The main loop's Turns of the entries, each clipped, oldest first. */
export const historyTurns = (entries: ReadonlyArray<SessionLogEntry>): Array<HistoryTurn> =>
  readLog(entries).turns.map(historyTurn)

/**
 * The page of Turns `GET /mod/history` answers: the latest `limit` that started before `before`
 * (the latest without it), oldest first, and, when there are earlier ones, the `before` that
 * reads them. `earlier` says Turns start before the entries given, as when they are the log's
 * last few Turns alone (SessionLog's `lastTurns`).
 */
export const historyPage = (
  entries: ReadonlyArray<SessionLogEntry>,
  ask: {
    readonly before?: EventSeq | undefined
    readonly limit: number
    readonly earlier?: boolean
  },
): ModHistory => {
  const before = readLog(entries).turns.filter(
    (turn) => ask.before === undefined || turn.seq < ask.before,
  )
  const page = before.slice(Math.max(0, before.length - ask.limit))
  const first = page[0]
  const more = page.length < before.length || ask.earlier === true
  return {
    turns: page.map(historyTurn),
    ...(first !== undefined && more && { earlierBefore: first.seq }),
  }
}

/** A time as the handoff says it: `2026-10-18 09:03 UTC`. */
const timeText = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`

/** How a Turn ended, when not with its answer. */
const endText = (turn: LoggedTurn) => {
  switch (turn.ended?.reason) {
    case undefined:
      return "It hadn't ended."
    case "stop":
      return undefined
    case "length":
      return "It stopped at the model's output limit."
    case "aborted":
      return turn.answer === "" ? "It was stopped before it answered." : "It was stopped."
    case "error":
      return turn.ended.errorMessage === undefined
        ? "It ended in an error."
        : `It ended in an error: ${clip(turn.ended.errorMessage, 500)}`
  }
}

/** A Turn as the handoff tells it. */
const turnBlock = (turn: LoggedTurn) => {
  const told = historyTurn(turn)
  const by = turn.sender._tag === "FromTerminal" ? "someone at the terminal" : told.by
  const lines = [`## Turn ${turn.seq}, ${timeText(turn.at)}: ${by} prompted`, told.prompt]
  if (told.tools.length > 0) lines.push("", "Tools called:", ...told.tools.map((t) => `- ${t}`))
  if (told.answer !== "") {
    lines.push("", told.model === undefined ? "Answer:" : `Answer (${told.model}):`, told.answer)
  }
  const ended = endText(turn)
  if (ended !== undefined) lines.push("", ended)
  return lines.join("\n")
}

/** The handoff the agent is given (DeliverHandoff), and the earliest Turn it leaves out. */
export interface Handoff {
  readonly text: string
  /** The `before` that reads the Turns left out with the history tool, when some are. */
  readonly earlierBefore?: EventSeq
}

/**
 * The handoff of the entries a Harness hasn't seen: each Turn and model switch among them, oldest
 * first, the newest that fit `budget` characters. Nothing when the entries hold no Turn. The mod
 * frames it for its agent: that it's context from the other Harness, not a request, and how to
 * read what it leaves out.
 */
export const buildHandoff = (input: {
  readonly entries: ReadonlyArray<SessionLogEntry>
  readonly budget?: number
}): Handoff | undefined => {
  const { turns, notes } = readLog(input.entries)
  if (turns.length === 0) return undefined
  const budget = input.budget ?? HandoffBudget
  const items = [
    ...turns.map((turn) => ({ seq: turn.seq, isTurn: true, text: turnBlock(turn) })),
    ...notes.map((note) => ({
      seq: note.seq,
      isTurn: false,
      text: `## ${timeText(note.at)}: ${note.text}`,
    })),
  ].toSorted((a, b) => a.seq - b.seq)

  let used = 0
  const kept: Array<(typeof items)[number]> = []
  for (const item of items.toReversed()) {
    const cost = item.text.length + (kept.length === 0 ? 0 : 2)
    if (used + cost > budget) break
    used += cost
    kept.unshift(item)
  }
  // What the agent has starts at the earliest Turn kept: the Turns before it are left out, and a
  // note before it with them.
  const keptTurns = kept.filter((item) => item.isTurn)
  const earlierBefore =
    keptTurns.length < turns.length ? (keptTurns[0]?.seq ?? items.at(-1)?.seq) : undefined
  return {
    text: kept
      .filter((item) => earlierBefore === undefined || item.seq >= earlierBefore)
      .map((item) => item.text)
      .join("\n\n"),
    ...(earlierBefore !== undefined && { earlierBefore }),
  }
}

/** A few of a Session's last Turns, as SessionLog's `lastTurns` reads them. */
export interface LastTurns {
  readonly entries: ReadonlyArray<SessionLogEntry>
  /** Whether a Turn starts before them. */
  readonly earlier: boolean
}

/**
 * The handoff of a log a Harness hasn't seen, which `read` gives a few Turns at a time from the
 * end (SessionLog's `lastTurns`, after where the Harness last saw it), read until the handoff is
 * full or there are no Turns before: so a long Session's start is never read. The same as
 * `buildHandoff` of the whole of it, and the last entry it covers, for the Harness to have seen.
 */
export const readHandoff = Effect.fnUntraced(function* <E, R>(
  read: (range: {
    readonly count: number
    readonly before?: EventSeq
  }) => Effect.Effect<LastTurns, E, R>,
) {
  let entries: ReadonlyArray<SessionLogEntry> = []
  let before: EventSeq | undefined
  for (;;) {
    const page = yield* read({
      count: HandoffReadTurns,
      ...(before !== undefined && { before }),
    })
    entries = [...page.entries, ...entries]
    const handoff = buildHandoff({ entries })
    const first = page.entries[0]
    if (!page.earlier || first === undefined || handoff?.earlierBefore !== undefined) {
      return { handoff, through: entries.at(-1)?.seq }
    }
    before = first.seq
  }
})
