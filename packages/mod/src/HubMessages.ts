// The messages hub-link exchanges with the Hub (see the protocol's Mod.ts), checked against the
// protocol's schemas: every event is validated before it is queued, so one bad event can't make
// the Hub refuse a whole batch, and every reply is decoded before the mod acts on it.

import {
  attachmentCount,
  attachmentLabels,
  attachmentRules,
  MaxAttachmentBytes,
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
  ModCommand,
  ModEventsEncoded,
  Participant,
  Question,
  TurnEndReason,
  TurnUsage,
} from "@kndl/protocol"
import { Exit, Schema } from "effect"

export type ModEventEncoded = typeof ModEvent.Encoded

/** One of the Hub's commands to a mod, by its tag. */
export type Command<Tag extends ModCommand["_tag"]> = Extract<ModCommand, { readonly _tag: Tag }>

/** A Participant as JSON: the Hub's commands carry them, and the events say them back. */
export type Sender = typeof Participant.Encoded

/** Whether `value` is a plain object: not null, and not an array. */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const clipNote = (cut: number) => `… (${cut} more chars)`

/** Shortens `text` to at most `max` characters, saying how much was cut. */
export const clip = (text: string, max = MaxToolSummaryLength) => {
  if (text.length <= max) return text
  // The note's own length depends on how much is cut; leave room for its longest form.
  const kept = max - clipNote(text.length).length
  return `${text.slice(0, Math.max(0, kept))}${clipNote(text.length - Math.max(0, kept))}`
}

/** What a mod's hello says of it. */
export interface HelloFields {
  readonly sessionId: string
  readonly conversationId: string
  readonly model: string
  /** It takes a SwitchModel (ADR 0029): kndl's pi extension does, the Claude Code plugins don't. */
  readonly switchesModels?: true
}

/**
 * The body of `POST /mod/hello`: this mod steers prompts into a running Turn (#195), marks the
 * files of a steered prompt, a message to a subagent and a reply (#278), and takes a context
 * handoff, serving its agent the Session's earlier Turns (ADR 0030).
 */
export const helloBody = ({ switchesModels, ...hello }: HelloFields) =>
  JSON.stringify(
    Schema.encodeSync(ModHello)(
      Schema.decodeUnknownSync(ModHello)({
        _tag: "ModHello",
        protocolVersion: ProtocolVersion,
        ...hello,
        steers: true,
        attaches: true,
        takesHandoffs: true,
        ...(switchesModels === true && { switchesModels }),
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

/** Claude Code's `turn.complete` reason, as pi-ai names a stop: a refusal is an error. */
export const turnEndReason = (
  reason: "answer" | "aborted" | "refusal" | "error",
): TurnEndReason => {
  switch (reason) {
    case "answer":
      return "stop"
    case "aborted":
      return "aborted"
    case "refusal":
    case "error":
      return "error"
  }
}

/** Claude Code's turn usage, as pi-ai names it. Claude Code reports no cost. */
export const turnUsage = (usage: {
  readonly model: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}): TurnUsage => ({
  model: usage.model,
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
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
 * Claude Code frames a prompt typed while it works, with the sender's name and a marker for each
 * file it carries (#278), which Claude opens by the marker alone.
 */
export const steeredPrompt = (
  sender: Pick<Participant, "name">,
  text: string,
  attachments: ReadonlyArray<MarkedFile> = [],
) =>
  [
    "<system-reminder>",
    `${sender.name} sent a new message while you were working:`,
    deliveredPrompt(sender, text, attachments),
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
    'Opens a file someone in this shared session attached to a message, by the id its marker gives: "[Image #1: shot.png (attachment <id>)]" or "[PDF #1: spec.pdf (attachment <id>)]". Returns the image or PDF itself. Call it once per file.',
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The attachment id from the marker." } },
    required: ["id"],
  },
  isDeferred: false,
}

/**
 * A prompt from the Prompt queue as Claude reads it: its sender's name, then each file's marker. A
 * message to a subagent, and a reply to a question, read the same (#278).
 */
export const deliveredPrompt = (
  sender: Pick<Participant, "name">,
  text: string,
  attachments: ReadonlyArray<MarkedFile>,
) => promptFromParticipant(sender, withAttachmentMarkers(text, attachments))

/**
 * What Claude reads beside a prompt with files, and the people never see: to open each one before
 * answering. The marker alone would do; this makes sure it isn't skipped.
 */
export const attachmentContext = (
  attachments: ReadonlyArray<MarkedFile>,
  toolName: string = attachmentToolName,
) => {
  const labels = attachmentLabels(attachments)
  const files = attachments.map((file, index) => `${labels[index]} ${file.name}: id ${file.id}`)
  return [
    `This message has ${attachmentCount(attachments)} attached. Look at each before you answer,`,
    `by calling ${toolName} once per file with its id: ${files.join("; ")}.`,
  ].join(" ")
}

interface Base64Source {
  readonly type: "base64"
  readonly media_type: string
  readonly data: string
}

/**
 * What the attachment tool answers: the Hub's file as an image block, or a PDF as a document
 * block (#277); or why it couldn't.
 */
export type AttachmentResult =
  | { readonly deny: string }
  | {
      readonly result: readonly [
        { readonly type: "text"; readonly text: string },
        (
          | { readonly type: "image"; readonly source: Base64Source }
          | { readonly type: "document"; readonly title: string; readonly source: Base64Source }
        ),
      ]
    }

const decodeAttachment = Schema.decodeUnknownExit(Schema.fromJsonString(ModAttachment))

const failed = (why: string) => ({ deny: `Could not open the attachment: ${why}` })

/** The most parts the attachment tool fetches of one file: as many as the largest, a PDF, has. */
export const maxAttachmentParts = Math.ceil(MaxAttachmentBytes / MaxModAttachmentPartBytes)

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

/** A GET of a path on the Hub, with the mod token, as the attachment tool fetches. */
export type HubGet = (path: string) => Promise<{ readonly status: number; readonly text: string }>

/**
 * The attachment tool's answer for the file `id`, its parts fetched from the Hub with `get` in
 * order, each from where the last says the next starts; or why it couldn't.
 */
export const openAttachment = async (id: string, get: HubGet): Promise<AttachmentResult> => {
  if (id === "") return { deny: "Give the attachment's id, from its marker." }
  const parts: Array<ModAttachment> = []
  for (let offset: number | undefined = 0; offset !== undefined;) {
    if (parts.length === maxAttachmentParts) break
    let response: { readonly status: number; readonly text: string }
    try {
      response = await get(attachmentPartPath(id, offset))
    } catch (error) {
      return failed(String(error))
    }
    const answer = attachmentPart(response.status, response.text)
    if ("deny" in answer) return answer
    parts.push(answer.part)
    offset = answer.part.next
  }
  return attachmentResult(parts)
}

/**
 * The attachment tool's answer from a file's parts, in order: an image block of the whole, or a
 * document block for a PDF.
 */
export const attachmentResult = (parts: ReadonlyArray<ModAttachment>): AttachmentResult => {
  const [first] = parts
  if (first === undefined || parts.at(-1)?.next !== undefined)
    return failed("the Hub sent only part of it.")
  const source = {
    type: "base64",
    media_type: first.mediaType,
    data: parts.map((part) => part.data).join(""),
  } as const
  const name = { type: "text", text: first.name } as const
  return {
    result:
      attachmentRules(first.mediaType).block === "image"
        ? [name, { type: "image", source }]
        : [name, { type: "document", title: first.name, source }],
  }
}

/**
 * What the model is told about the Session being shared, in the system prompt: others watch, and
 * only the person who started it drives it (ADR 0026); with the name its Harness gives the
 * attachment tool.
 */
export const sharedSessionNoteFor = (toolName: string) =>
  [
    "This session is shared through kndl: other people may watch it, and your subagents, live in a",
    "web UI, but only the person who started it sends it prompts, answers your questions, and",
    "messages or stops a subagent. A prompt that starts with their name in brackets, such as",
    '"[Ada Lovelace] ...", came from the web UI; a prompt without one was typed at the terminal.',
    "You run in a sandbox VM where the repository is checked out. A line such as",
    '"[Image #1: name (attachment id)]" or "[PDF #1: name (attachment id)]" in a message stands for',
    `a file its sender attached: to see it, call ${toolName} with its id.`,
  ].join(" ")

/** {@link sharedSessionNoteFor} the Claude Code plugins' attachment tool. */
export const sharedSessionNote = sharedSessionNoteFor(attachmentToolName)

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
