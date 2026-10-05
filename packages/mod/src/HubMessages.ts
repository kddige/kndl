// The messages hub-link exchanges with the Hub (see the protocol's Mod.ts), checked against the
// protocol's schemas: every event is validated before it is queued, so one bad event can't make
// the Hub refuse a whole batch, and every reply is decoded before the mod acts on it.

import {
  ChildReply,
  ChildRequest,
  MaxToolSummaryLength,
  ModCommands,
  ModEvent,
  ModHello,
  ModHelloReply,
  ProtocolVersion,
} from "@claude-hub/protocol"
import type { ModEventsEncoded, Participant, TurnEndReason, TurnUsage } from "@claude-hub/protocol"
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

/** The body of `POST /mod/children`. */
export const childRequestBody = (request: ChildRequest) =>
  JSON.stringify(Schema.encodeSync(ChildRequest)(request))

const decodeChildReply = Schema.decodeUnknownExit(Schema.fromJsonString(ChildReply))

/** Reads the Hub's answer to `POST /mod/children`; undefined when it isn't one. */
export const readChildReply = (text: string): ChildReply | undefined => {
  const reply = decodeChildReply(text)
  return Exit.isSuccess(reply) ? reply.value : undefined
}

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

/** A prompt from a Participant, as the model reads it: led by the sender's name. */
export const promptFromParticipant = (sender: Participant, text: string) =>
  `[${sender.name}] ${text}`

/** What the model is told about the Session being shared, in the system prompt. */
export const sharedSessionNote = [
  "This session is shared through Claude Hub: several people may watch it live in a web UI and",
  'send it prompts. A prompt that starts with a name in brackets, such as "[Ada Lovelace] ...",',
  "came from that person; a prompt without one was typed at the terminal. A prompt that starts",
  'with a note such as "[Report from Child Session ...]" or "[Message from your Parent Session',
  '..." came from another Claude Hub Session, not a person. When it matters who asked for what,',
  "address people by name. Your file and command tools run in a sandbox VM where",
  "the repository is checked out; nothing you run reaches the machine Claude Code runs on.",
  // Claude Code's own guidance says to suggest `! <command>` (#132); the mod refuses `!`.
  "The `! <command>` prompt shortcut would run on that machine, so it is off in this session and",
  "you never suggest it: run a command yourself with Bash, in the sandbox, and if only a person",
  "can run it, such as an interactive login, tell them what to run and where.",
].join(" ")

/** What the Runner tells the mod about the Session's Sandbox (the Runner's ClaudeLaunch.ts). */
export interface SandboxFacts {
  /** Where the Workspace, the Repo's checkout, is mounted in the Sandbox. */
  readonly workspace: string
  readonly repo: string | undefined
  readonly workBranch: string | undefined
}

/**
 * What the model is told about where its tools run, in the system prompt (#127).
 *
 * Claude Code's own environment block describes the host it runs on: its empty per-Session
 * directory, which is no git repository, and the host's platform and OS. That is not where the
 * tools run. Claude Code also leaves it off a prompt a mod submits, as the Hub's are, and sends it
 * only with a later tool result, so a Session driven from the Hub got it late, after the model
 * had already guessed. This section replaces it, and is in the system prompt from the first
 * request. The Sandbox is always Linux, and its tool server runs commands with bash (the Runner's
 * ToolBridge.ts).
 */
export const sandboxEnvironment = (facts: SandboxFacts) =>
  [
    "# Sandbox environment",
    "Your file and command tools run in this Session's sandbox, a Linux machine of its own:",
    ` - Primary working directory: ${facts.workspace}`,
    " - Is a git repository: true",
    ...(facts.repo === undefined
      ? []
      : [` - Repository: ${facts.repo}, checked out at ${facts.workspace}`]),
    ...(facts.workBranch === undefined
      ? []
      : [` - Work branch: ${facts.workBranch}, the branch this Session was started on`]),
    " - Platform: linux",
    " - Shell: bash",
    "Claude Code itself runs on another machine, which your tools never reach: use the paths above, not a path or platform you see for that machine.",
  ].join("\n")

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
