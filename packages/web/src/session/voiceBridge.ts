// Live voice's bridge (ADR 0033): between GPT-Live, which holds the spoken conversation with client
// delegation, and the Session underneath, which does the work. Framework-free, so it can be tested
// without a browser:
//
// - What the person says is heard as transcript deltas. When GPT-Live delegates, the work it names,
//   or else everything they said since the last delegation, becomes a prompt to the Session, from
//   them, or their reply to its Open question while it asks one.
// - Each delegation follows the Turn its prompt started. While it runs, GPT-Live is told quietly
//   what the agent is doing, now and then; when it ends, it is given the agent's answer to say.
//   A question the agent asks is put to GPT-Live to ask.

import type { OpenQuestion, SessionSummary } from "@kndl/protocol"
import type { Block, TurnView } from "../hub/transcript.ts"

/** The most characters one append carries: GPT-Live takes 500 tokens at most. */
export const MaxAppendChars = 1800

/** How often GPT-Live is told what a working agent is doing, at most. */
export const ProgressEveryMs = 20_000

/**
 * What the bridge tells GPT-Live, whatever its protocol (liveVoice.ts says it in GPT-Live's
 * events): `quiet`, context it uses without saying; `say`, what it is to say.
 */
export interface VoiceEvent {
  readonly kind: "quiet" | "say"
  readonly id: string
  /** The delegation it is about; null for the session as a whole. */
  readonly delegationId: string | null
  readonly content: string
}

/** What the bridge does to the Session, as its Creator. */
export interface SessionDriver {
  readonly sendPrompt: (text: string) => boolean
  readonly reply: (question: OpenQuestion, text: string) => boolean
}

/** The Session as the bridge follows it: its summary, and its Turns, oldest first. */
export interface SessionView {
  readonly summary: SessionSummary
  readonly turns: ReadonlyArray<TurnView>
}

interface Delegation {
  readonly id: string
  /** The prompt it sent; undefined when it replied to a question instead. */
  readonly prompt: string | undefined
  readonly at: number
  /** The Turn its prompt started, once seen. */
  turnId?: string
  progressAt: number
  lastProgress?: string
}

const clip = (text: string, limit = MaxAppendChars) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/** The agent's answer in a Turn: its text after its last tool call, else all its text. */
export const answerOf = (blocks: ReadonlyArray<Block>): string => {
  const texts: Array<string> = []
  for (const block of blocks) {
    if (block.kind === "tool") texts.length = 0
    else if (block.kind === "text" && block.text.trim() !== "") texts.push(block.text.trim())
  }
  if (texts.length > 0) return texts.join("\n\n")
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text.trim()] : []))
    .filter((text) => text !== "")
    .join("\n\n")
}

/** What a working Turn is doing now: its latest tool call, as a line. */
const progressOf = (turn: TurnView): string | undefined => {
  const tools = turn.blocks.flatMap((block) => (block.kind === "tool" ? [block.call] : []))
  const latest = tools.at(-1)
  if (latest === undefined) return undefined
  return `The agent is working: ${tools.length} tool calls so far, the latest ${latest.tool} ${clip(latest.input, 160)}.`
}

/** An Open question, as GPT-Live is to put it to the person. */
export const questionText = (question: OpenQuestion): string =>
  clip(
    `The agent asks: ${question.questions
      .map((asked) => {
        const options = asked.options.map((option) => option.label).join(", ")
        return options === "" ? asked.question : `${asked.question} (options: ${options})`
      })
      .join(" Also: ")} Ask them, and delegate their answer.`,
  )

export class VoiceBridge {
  #heard = ""
  #delegations: Array<Delegation> = []
  #asked: string | undefined
  #events = 0
  #view: SessionView | undefined

  constructor(
    private readonly driver: SessionDriver,
    private readonly send: (event: VoiceEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A delta of what the person said. */
  heard(delta: string): void {
    this.#heard += delta
  }

  /**
   * GPT-Live delegated: the work it names, if its protocol says (Codex's does), else what the
   * person said since the last delegation, goes to the Session.
   */
  delegated(delegationId: string, asked?: string): void {
    const heard = this.#heard
    this.#heard = ""
    const task = (asked?.trim() || heard.trim()).replaceAll(/\s+/g, " ")
    const say = (kind: VoiceEvent["kind"], content: string) =>
      this.#emit(kind, delegationId, content)
    if (task === "") {
      say("quiet", "Nothing they said came through to pass on: ask them again.")
      return
    }
    const question = this.#view?.summary.openQuestion
    if (question !== undefined) {
      if (!this.driver.reply(question, task)) {
        say("say", "Their answer couldn't reach the agent just now.")
        return
      }
      this.#delegations.push({
        id: delegationId,
        prompt: undefined,
        at: this.now(),
        progressAt: -Infinity,
      })
      say("quiet", "Their answer went to the agent; it works on.")
      return
    }
    if (!this.driver.sendPrompt(task)) {
      say("say", "The Session can't take a prompt just now.")
      return
    }
    this.#delegations.push({
      id: delegationId,
      prompt: task,
      at: this.now(),
      progressAt: -Infinity,
    })
    say("quiet", "Passed to the agent; it is working on it.")
  }

  /** The Session changed: follow its Turns, and tell GPT-Live what it should know. */
  observe(view: SessionView): void {
    this.#view = view
    const question = view.summary.openQuestion
    const latest = this.#delegations.at(-1)
    if (question !== undefined && question.toolCallId !== this.#asked) {
      this.#asked = question.toolCallId
      this.#emit("say", latest?.id ?? null, questionText(question))
    }
    for (const delegation of this.#delegations) {
      if (delegation.turnId === undefined) {
        // The Turn its prompt started; a reply's goes on in the Turn running.
        const started = view.turns.find(
          (turn) =>
            !this.#delegations.some((other) => other.turnId === turn.turnId) &&
            (delegation.prompt === undefined
              ? turn.end === null
              : turn.prompt.trim() === delegation.prompt && turn.at >= delegation.at - 60_000),
        )
        if (started === undefined) continue
        delegation.turnId = started.turnId
      }
      const turn = view.turns.find((candidate) => candidate.turnId === delegation.turnId)
      if (turn === undefined) continue
      if (turn.end !== null) {
        const answer = answerOf(turn.blocks)
        this.#emit(
          "say",
          delegation.id,
          answer === ""
            ? "The agent finished without saying anything."
            : `The agent finished. Its answer: ${answer}`,
        )
        this.#delegations = this.#delegations.filter((other) => other !== delegation)
        continue
      }
      const progress = progressOf(turn)
      const now = this.now()
      if (
        progress !== undefined &&
        progress !== delegation.lastProgress &&
        now - delegation.progressAt >= ProgressEveryMs
      ) {
        delegation.progressAt = now
        delegation.lastProgress = progress
        this.#emit("quiet", delegation.id, progress)
      }
    }
  }

  #emit(kind: VoiceEvent["kind"], delegationId: string | null, content: string) {
    this.send({ kind, id: `kndl_${++this.#events}`, delegationId, content: clip(content) })
  }
}
