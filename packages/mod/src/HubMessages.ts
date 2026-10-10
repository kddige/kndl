// The messages hub-link exchanges with the Hub (see the protocol's Mod.ts), checked against the
// protocol's schemas: every event is validated before it is queued, so one bad event can't make
// the Hub refuse a whole batch, and every reply is decoded before the mod acts on it.

import {
  imageCount,
  MaxImageBytes,
  MaxModAttachmentPartBytes,
  MaxToolSummaryLength,
  ModAttachment,
  ModCommands,
  ModEvent,
  ModHello,
  ModHelloReply,
  ProtocolVersion,
  withAttachmentMarkers,
} from "@kndl/protocol"
import type {
  MarkedFile,
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

/** The body of `POST /mod/hello`: this mod steers prompts into a running Turn (#195). */
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
        steers: true,
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
  if (Array.isArray(result) && result.every(isRecord)) return clip(blocksSummary(result))
  return clip(typeof result === "string" ? result : (JSON.stringify(result) ?? ""))
}

/**
 * Content blocks, as a tool such as the attachment tool answers: their text, and a note of each
 * image or other block, never its bytes.
 */
const blocksSummary = (blocks: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  blocks
    .map((block) => {
      if (block.type === "text") return text(block.text)
      const source = isRecord(block.source) ? block.source : {}
      return `[${text(source.media_type) || text(block.type) || "block"}]`
    })
    .join("\n")

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
export const promptFromParticipant = (sender: Pick<Participant, "name">, text: string) =>
  `[${sender.name}] ${text}`

/**
 * A prompt a Participant steered into the running Turn (#195, ADR 0018), as the model reads it: as
 * Claude Code frames a prompt typed while it works, with the sender's name.
 */
export const steeredPrompt = (sender: Pick<Participant, "name">, text: string) =>
  [
    "<system-reminder>",
    `${sender.name} sent a new message while you were working:`,
    promptFromParticipant(sender, text),
    "",
    "Address the message above as you continue this turn.",
    "</system-reminder>",
  ].join("\n")

// ── Attachments (#276, ADR 0024) ───────────────────────────────────────────

/** The tool hub-link-commands registers, by its short name. */
export const attachmentTool = "attachment"

/** The tool as Claude calls it: Claude Code names a plugin's tools after the plugin. */
export const attachmentToolName = `mcp__hub-link-commands__${attachmentTool}`

/**
 * The tool, as `$.tool.register` takes it: in the tool list from the first request on, not behind
 * ToolSearch, so Claude can open a file without first searching for how.
 */
export const attachmentToolSpec = {
  name: attachmentTool,
  description:
    'Opens a file someone in this shared session attached to a message, by the id its marker gives: "[Image #1: shot.png (attachment <id>)]". Returns the image itself. Call it once per file.',
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The attachment id from the marker." } },
    required: ["id"],
  },
  isDeferred: false,
}

/** A prompt from the Prompt queue as Claude reads it: its sender's name, then each file's marker. */
export const deliveredPrompt = (
  sender: Pick<Participant, "name">,
  text: string,
  attachments: ReadonlyArray<MarkedFile>,
) => promptFromParticipant(sender, withAttachmentMarkers(text, attachments))

/**
 * What Claude reads beside a prompt with files, and the people never see: to open each one before
 * answering. The marker alone would do; this makes sure it isn't skipped.
 */
export const attachmentContext = (attachments: ReadonlyArray<MarkedFile>) => {
  const files = attachments.map((file, index) => `#${index + 1} ${file.name}: id ${file.id}`)
  const count = imageCount(attachments.length)
  return [
    `This message has ${count} attached. Look at each before you answer, by calling`,
    `${attachmentToolName} once per image with its id: ${files.join("; ")}.`,
  ].join(" ")
}

/** What the attachment tool answers: the Hub's file as an image block, or why it couldn't. */
export type AttachmentResult =
  | { readonly deny: string }
  | {
      readonly result: readonly [
        { readonly type: "text"; readonly text: string },
        {
          readonly type: "image"
          readonly source: {
            readonly type: "base64"
            readonly media_type: string
            readonly data: string
          }
        },
      ]
    }

const decodeAttachment = Schema.decodeUnknownExit(Schema.fromJsonString(ModAttachment))

const failed = (why: string) => ({ deny: `Could not open the attachment: ${why}` })

/** The most parts the attachment tool fetches of one file: as many as the largest has. */
export const maxAttachmentParts = Math.ceil(MaxImageBytes / MaxModAttachmentPartBytes)

/** Where the attachment tool fetches a file's part from `offset` on, on the Hub. */
export const attachmentPartPath = (id: string, offset: number) =>
  `/mod/attachments/${encodeURIComponent(id)}?offset=${offset}`

/**
 * A part of a file, from the Hub's answer to {@link attachmentPartPath}; or the attachment tool's
 * answer saying why there is none. The mod runtime's fetch reads 4 MiB of a body at most, so a
 * large file comes in parts, each saying where the next starts.
 */
export const attachmentPart = (
  status: number,
  body: string,
): { readonly part: ModAttachment } | { readonly deny: string } => {
  if (status !== 200) {
    try {
      const { error } = JSON.parse(body) as { error?: unknown }
      if (typeof error === "string") return failed(error)
    } catch {
      // Said below.
    }
    return failed(`the Hub answered ${status}.`)
  }
  const part = decodeAttachment(body)
  if (Exit.isFailure(part)) return failed("the Hub's answer was not one.")
  return { part: part.value }
}

/** The attachment tool's answer from a file's parts, in order: an image block of the whole. */
export const attachmentResult = (parts: ReadonlyArray<ModAttachment>): AttachmentResult => {
  const [first] = parts
  if (first === undefined || parts.at(-1)?.next !== undefined)
    return failed("the Hub sent only part of it.")
  return {
    result: [
      { type: "text", text: first.name },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: first.mediaType,
          data: parts.map((part) => part.data).join(""),
        },
      },
    ],
  }
}

/** What the model is told about the Session being shared, in the system prompt. */
export const sharedSessionNote = [
  "This session is shared through kndl: several people may watch it live in a web UI and",
  'send it prompts. A prompt that starts with a name in brackets, such as "[Ada Lovelace] ...",',
  "came from that person; a prompt without one was typed at the terminal. They can watch your",
  "subagents too, and message or stop one. When it matters who asked for what, address people",
  "by name. You run in a sandbox VM where the repository is checked out. A line such as",
  '"[Image #1: name (attachment id)]" in a message stands for a file its sender attached: to see',
  `it, call ${attachmentToolName} with its id.`,
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

/**
 * How Claude Code tells Claude that the user refused a tool call and said something instead, which
 * follows it. A Participant's Replied answers with it, with their name: a refusal reaches Claude
 * whatever the tool's result looks like.
 */
export const repliedPrefix =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"

/** An AskUserQuestion call's result from a hook, as Claude Code's dialog would have it. */
export type AnswerResult =
  | { readonly deny: string }
  | {
      readonly result: {
        readonly questions: unknown
        readonly answers: Readonly<Record<string, string>>
        readonly annotations?: Readonly<Record<string, never>>
      }
    }

/**
 * What an AskUserQuestion call answers with a Participant's answer, as Claude Code's dialog
 * would: the answers keyed by question, with no annotations, as its Submit does; a reply, as the
 * call refused with what the sender said instead; or, dismissed, what Esc does.
 */
export const answerResult = (
  questions: unknown,
  answer: QuestionAnswer,
  sender: Pick<Participant, "name">,
): AnswerResult => {
  switch (answer._tag) {
    case "Answered":
      return { result: { questions, answers: answer.answers, annotations: {} } }
    case "Replied":
      return { deny: `${repliedPrefix}${promptFromParticipant(sender, answer.text)}` }
    case "Dismissed":
      return { deny: dismissedText }
  }
}

/**
 * How an AskUserQuestion call answered at the terminal closed its question: with the answers
 * chosen; refused with something said instead, replied; or otherwise refused (Esc, or "Chat about
 * this"), dismissed. A dialog that timed out with nobody at the keyboard, set to, closed it with no
 * answer from anyone: cancelled (#206).
 */
export const terminalOutcome = (done: {
  readonly deny?: string | undefined
  readonly isError?: true | undefined
  readonly result?: unknown
}): QuestionOutcome => {
  if (done.deny?.startsWith(repliedPrefix) === true) {
    const said = done.deny.slice(repliedPrefix.length)
    if (said.trim() !== "") return { _tag: "Replied", text: said }
  }
  if (done.deny !== undefined || done.isError === true || !isRecord(done.result))
    return { _tag: "Dismissed" }
  const given = isRecord(done.result.answers) ? done.result.answers : {}
  const answers = Object.fromEntries(
    Object.entries(given).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
  if (Object.keys(answers).length === 0 && done.result.afkTimeoutMs !== undefined)
    return { _tag: "Cancelled" }
  return { _tag: "Answered", answers }
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
