// The messages hub-link exchanges with the Hub (see the protocol's Mod.ts), checked against the
// protocol's schemas: every event is validated before it is queued, so one bad event can't make
// the Hub refuse a whole batch, and every reply is decoded before the mod acts on it.

import {
  MaxToolSummaryLength,
  ModCommands,
  ModEvent,
  ModHello,
  ModHelloReply,
  ProtocolVersion,
} from "@kndl/protocol"
import type {
  ModEventsEncoded,
  Participant,
  Question,
  QuestionAnswer,
  QuestionOutcome,
  TurnEndReason,
  TurnUsage,
} from "@kndl/protocol"
import { Exit, Schema } from "effect"

export type ModEventEncoded = typeof ModEvent.Encoded

const clipNote = (cut: number) => `… (${cut} more chars)`

/** Shortens `text` to at most `max` characters, saying how much was cut. */
export const clip = (text: string, max = MaxToolSummaryLength) => {
  if (text.length <= max) return text
  // The note's own length depends on how much is cut; leave room for its longest form.
  const kept = max - clipNote(text.length).length
  return `${text.slice(0, Math.max(0, kept))}${clipNote(text.length - Math.max(0, kept))}`
}

/** The body of `POST /mod/hello`. */
export const helloBody = (hello: {
  readonly sessionId: string
  readonly claudeSessionId: string
  readonly model: string
}) =>
  JSON.stringify(
    Schema.encodeSync(ModHello)(
      Schema.decodeUnknownSync(ModHello)({
        _tag: "ModHello",
        protocolVersion: ProtocolVersion,
        ...hello,
      }),
    ),
  )

const decodeEvent = Schema.decodeUnknownExit(ModEvent)
const encodeEvent = Schema.encodeSync(ModEvent)

/**
 * Checks `event` against the protocol and returns it encoded for the Hub, or the reason it
 * doesn't decode.
 */
export const checkEvent = (
  event: unknown,
):
  | { readonly _tag: "Valid"; readonly event: ModEventEncoded }
  | { readonly _tag: "Invalid"; readonly reason: string } => {
  const decoded = decodeEvent(event)
  if (Exit.isFailure(decoded)) return { _tag: "Invalid", reason: String(decoded.cause) }
  return { _tag: "Valid", event: encodeEvent(decoded.value) }
}

/** The body of `POST /mod/events`, from events {@link checkEvent} passed. */
export const eventsBody = (messages: ReadonlyArray<ModEventEncoded>) =>
  JSON.stringify({ messages } satisfies ModEventsEncoded)

const decodeHelloReply = Schema.decodeUnknownExit(Schema.fromJsonString(ModHelloReply))
const decodeCommands = Schema.decodeUnknownExit(Schema.fromJsonString(ModCommands))

/** Reads the Hub's answer to a hello; undefined when it isn't one. */
export const readHelloReply = (text: string): ModHelloReply | undefined => {
  const reply = decodeHelloReply(text)
  return Exit.isSuccess(reply) ? reply.value : undefined
}

/** Reads the Hub's answer to `GET /mod/commands`; undefined when it isn't one. */
export const readCommands = (text: string): ModCommands | undefined => {
  const commands = decodeCommands(text)
  return Exit.isSuccess(commands) ? commands.value : undefined
}

/** Claude Code's `turn.complete` reason, as the protocol names it. */
export const turnEndReason = (
  reason: "answer" | "aborted" | "refusal" | "error",
): TurnEndReason => {
  switch (reason) {
    case "answer":
      return "Answered"
    case "aborted":
      return "Stopped"
    case "refusal":
      return "Refused"
    case "error":
      return "Failed"
  }
}

/** Claude Code's turn usage, as the protocol names it. */
export const turnUsage = (usage: {
  readonly model: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}): TurnUsage => ({
  model: usage.model,
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadInputTokens: usage.cache_read_input_tokens,
  cacheCreationInputTokens: usage.cache_creation_input_tokens,
})

/** The keys Claude Code adds to a tool call's input that the tool itself never sees. */
const reservedKeys: ReadonlySet<string> = new Set(["tool", "tool_use_id", "agentId", "consent"])

/** A tool call's own arguments, without the keys Claude Code adds beside them. */
export const toolArguments = (input: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([key]) => !reservedKeys.has(key)))

/** A tool's result as the web UI shows it: a command's output, or the record as JSON. */
export const resultSummary = (tool: string, result: unknown) => {
  if (tool === "Bash" && typeof result === "object" && result !== null) {
    const { stdout, stderr } = result as { stdout?: unknown; stderr?: unknown }
    const parts = [stdout, stderr].filter(
      (part): part is string => typeof part === "string" && part !== "",
    )
    return clip(parts.join("\n"))
  }
  return clip(typeof result === "string" ? result : (JSON.stringify(result) ?? ""))
}

/**
 * Whether a Stop moved this call to the background instead of ending it. Claude Code does that to a
 * running Bash command when its Turn is aborted: the result says the command still runs, not how it
 * ended (#165). That end comes later, in a task-notification Turn of its own.
 */
export const backgroundedByStop = (result: unknown) =>
  typeof result === "object" &&
  result !== null &&
  (result as { backgroundedByTurnAbort?: unknown }).backgroundedByTurnAbort === true

/**
 * A prompt from a Participant, or their message to a subagent, as the model reads it: led by the
 * sender's name.
 */
export const promptFromParticipant = (sender: Participant, text: string) =>
  `[${sender.name}] ${text}`

/** What the model is told about the Session being shared, in the system prompt. */
export const sharedSessionNote = [
  "This session is shared through kndl: several people may watch it live in a web UI and",
  'send it prompts. A prompt that starts with a name in brackets, such as "[Ada Lovelace] ...",',
  "came from that person; a prompt without one was typed at the terminal. They can watch your",
  "subagents too, and message or stop one. When it matters who asked for what, address people",
  "by name. You run in a sandbox VM where the repository is checked out.",
].join(" ")

/**
 * Whether a Turn that starts with `text` is the one a delivered prompt, `delivered`, started.
 * The Hub delivers one prompt at a time, only while the Session is idle, so it is the next Turn
 * with a prompt; but not a task notification Claude Code starts when a background agent ends,
 * unless the prompt rides along in it.
 */
export const startsDelivered = (text: string, delivered: string) =>
  text !== "" && (taskNotificationAgent(text) === undefined || text.includes(delivered))

/**
 * The agent a task notification is about, when `text` is one: the prompt Claude Code starts a
 * main-loop Turn with when a background agent ends or is stopped, with the agent's id as its
 * task id (spike #148).
 */
export const taskNotificationAgent = (text: string): string | undefined => {
  if (!text.trimStart().startsWith("<task-notification>")) return undefined
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1]
  return id === undefined || id === "" ? undefined : id
}

/**
 * The worktree an agent runs in, from the directory it starts in: `isolation: "worktree"` makes
 * `<workspace>/.claude/worktrees/<name>` on the branch `worktree-<name>` (ADR 0014). Undefined
 * for an agent that runs in the Workspace itself.
 */
export const agentWorktree = (
  cwd: string,
): { readonly path: string; readonly branch: string } | undefined => {
  const match = /^(.*\/\.claude\/worktrees\/([^/]+))\/?$/.exec(cwd)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { path: match[1], branch: `worktree-${match[2]}` }
}

// ── AskUserQuestion (#193) ─────────────────────────────────────────────────

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === "string" ? value : "")

/**
 * AskUserQuestion's `questions` input as the protocol carries them: each question with its
 * header, options and whether several may be picked. An entry that isn't a question is left out.
 */
export const askedQuestions = (questions: unknown): Array<Question> =>
  (Array.isArray(questions) ? questions : []).filter(isRecord).map((question) => ({
    question: text(question.question),
    header: text(question.header),
    options: (Array.isArray(question.options) ? question.options : [])
      .filter(isRecord)
      .map((option) => {
        const description = text(option.description)
        return { label: text(option.label), ...(description === "" ? {} : { description }) }
      }),
    multiSelect: question.multiSelect === true,
  }))

/**
 * What Claude reads when Esc closes Claude Code's dialog, as when a permission prompt is refused.
 * A Participant's Dismissed answers with it.
 */
export const dismissedText =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

/** An AskUserQuestion call's result from a hook, as Claude Code's dialog would have it. */
export type AnswerResult =
  | { readonly deny: string }
  | {
      readonly result: {
        readonly questions: unknown
        readonly answers: Readonly<Record<string, string>>
        readonly annotations?: Readonly<Record<string, never>>
        readonly response?: string
      }
    }

/**
 * What an AskUserQuestion call answers with a Participant's answer, as Claude Code's dialog
 * would: the answers keyed by question, with no annotations, as its Submit does; the reply, as
 * text typed instead of choosing; or, dismissed, what Esc does.
 */
export const answerResult = (questions: unknown, answer: QuestionAnswer): AnswerResult => {
  switch (answer._tag) {
    case "Answered":
      return { result: { questions, answers: answer.answers, annotations: {} } }
    case "Replied":
      return { result: { questions, answers: {}, response: answer.text } }
    case "Dismissed":
      return { deny: dismissedText }
  }
}

/**
 * How an AskUserQuestion call answered at the terminal closed its question: with the answers
 * chosen, with text typed instead, or, refused (Esc, or "Chat about this"), dismissed.
 */
export const terminalOutcome = (done: {
  readonly deny?: string | undefined
  readonly isError?: true | undefined
  readonly result?: unknown
}): QuestionOutcome => {
  if (done.deny !== undefined || done.isError === true || !isRecord(done.result))
    return { _tag: "Dismissed" }
  const response = text(done.result.response)
  if (response.trim() !== "") return { _tag: "Replied", text: response }
  const answers = isRecord(done.result.answers) ? done.result.answers : {}
  return {
    _tag: "Answered",
    answers: Object.fromEntries(
      Object.entries(answers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  }
}

const maxQueued = 5_000

/**
 * The events waiting to go to the Hub, oldest first. Consecutive text pieces of the same loop
 * are merged; past {@link maxQueued} events the oldest are dropped.
 */
export class Outbox {
  private events: Array<ModEventEncoded> = []

  get size() {
    return this.events.length
  }

  push(event: ModEventEncoded) {
    const last = this.events.at(-1)
    if (
      event._tag === "TextDelta" &&
      last?._tag === "TextDelta" &&
      last.turnId === event.turnId &&
      last.agentId === event.agentId
    ) {
      this.events[this.events.length - 1] = { ...last, text: last.text + event.text }
      return
    }
    this.events.push(event)
    if (this.events.length > maxQueued) this.events = this.events.slice(-maxQueued)
  }

  /** Takes everything queued, for one post. */
  take(): Array<ModEventEncoded> {
    const taken = this.events
    this.events = []
    return taken
  }

  /** Puts back a batch that couldn't be posted, ahead of what was queued since. */
  putBack(batch: ReadonlyArray<ModEventEncoded>) {
    this.events = [...batch, ...this.events].slice(-maxQueued)
  }
}
