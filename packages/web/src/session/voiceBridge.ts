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

import type {
  LiveVoicePromptAsk,
  OpenQuestion,
  QueuedPrompt,
  SessionSummary,
  VoiceLine,
} from "@kndl/protocol"
import type { Block, TurnView } from "../hub/transcript.ts"

/** The most characters the bridge tells GPT-Live at once: liveVoice.ts sends it in 500-byte appends. */
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
  /**
   * Writes what was said into the prompt the person means (liveVoice.ts asks the Hub); undefined,
   * or a rejection, when it can't, and what was said goes as it is. Without it, it always does.
   */
  readonly refine?: (ask: LiveVoicePromptAsk) => Promise<string | undefined>
}

/** The Session as the bridge follows it: its summary, and its Turns, oldest first. */
export interface SessionView {
  readonly summary: SessionSummary
  readonly turns: ReadonlyArray<TurnView>
  /** Its Prompt queue, where a prompt the bridge sent gets the id its Turn will carry. */
  readonly queue?: ReadonlyArray<QueuedPrompt>
}

interface Delegation {
  readonly id: string
  /** The prompt it sent; undefined when it replied to a question instead. */
  readonly prompt: string | undefined
  readonly at: number
  /** The Turns there were when it was made: its prompt's is none of them. */
  readonly before: ReadonlySet<string>
  /** Its prompt's id, once the Prompt queue shows it: the Turn it starts carries it. */
  promptId?: string
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

/** An Open question's words, with its options: what an answer to it is written against. */
const questionWords = (question: OpenQuestion): string =>
  question.questions
    .map((asked) => {
      const options = asked.options.map((option) => option.label).join(", ")
      return options === "" ? asked.question : `${asked.question} (options: ${options})`
    })
    .join(" ")

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
  /** Both sides of what was said since the last delegation, oldest first. */
  #exchange: Array<{ role: VoiceLine["role"]; text: string }> = []
  #delegations: Array<Delegation> = []
  #asked: string | undefined
  #events = 0
  #view: SessionView | undefined

  constructor(
    private readonly driver: SessionDriver,
    private readonly send: (event: VoiceEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * True once a reasoning model works behind the voice (spike): what the bridge says is then for
   * the conversation as a whole, not tied to a delegation of GPT-Live's.
   */
  sessionWide = false

  /**
   * The reasoning model's `send_to_agent`: sends the Session the prompt, and follows its Turn, as a
   * delegation's, to say its answer when it ends. Whether it went.
   */
  prompt(text: string): boolean {
    const task = text.trim()
    if (task === "" || !this.driver.sendPrompt(task)) return false
    this.#delegations.push({
      id: `tool_${++this.#events}`,
      prompt: task,
      at: this.now(),
      before: this.#turnIds(),
      progressAt: -Infinity,
    })
    return true
  }

  /** A delta of what the person said. */
  heard(delta: string): void {
    this.#heard += delta
    this.#line("user", delta)
  }

  /** A delta of what the voice said: what the person answers may build on it. */
  spoke(delta: string): void {
    this.#line("assistant", delta)
  }

  /**
   * GPT-Live delegated: what was said since the last delegation goes to the Session, written into
   * the prompt the person means, if the driver can write it, else as it was said: the work GPT-Live
   * names, if its protocol says (Codex's does), else the person's words. While the agent asks a
   * question, it is their answer.
   */
  delegated(delegationId: string, asked?: string): void {
    const heard = this.#heard
    this.#heard = ""
    const exchange = this.#exchange
      .map((line) => ({ role: line.role, text: line.text.trim().replaceAll(/\s+/g, " ") }))
      .filter((line) => line.text !== "")
    this.#exchange = []
    const said = (asked?.trim() || heard.trim()).replaceAll(/\s+/g, " ")
    if (said === "") {
      this.#emit("say", delegationId, "Nothing came through to pass on: ask them to say it again.")
      return
    }
    const question = this.#view?.summary.openQuestion
    const { refine } = this.driver
    if (refine === undefined) return this.#hand(delegationId, said, question, this.#turnIds())
    const before = this.#turnIds()
    const ask: LiveVoicePromptAsk = {
      exchange: exchange.some((line) => line.role === "user")
        ? exchange
        : [...exchange, { role: "user", text: said }],
      ...(asked !== undefined && asked.trim() !== "" && { asked: asked.trim() }),
      ...(question !== undefined && { question: questionWords(question) }),
    }
    void refine(ask).then(
      (written) => this.#hand(delegationId, written?.trim() || said, question, before),
      () => this.#hand(delegationId, said, question, before),
    )
  }

  /** Sends the Session `text`: the person's prompt, or their answer to `question`. */
  #hand(
    delegationId: string,
    text: string,
    question: OpenQuestion | undefined,
    before: ReadonlySet<string>,
  ) {
    const say = (kind: VoiceEvent["kind"], content: string) =>
      this.#emit(kind, delegationId, content)
    if (question !== undefined) {
      if (!this.driver.reply(question, text)) {
        say("say", "Their answer couldn't reach the agent just now.")
        return
      }
      this.#delegations.push({
        id: delegationId,
        prompt: undefined,
        at: this.now(),
        before,
        progressAt: -Infinity,
      })
      say("quiet", "Their answer went to the agent; it works on.")
      return
    }
    if (!this.driver.sendPrompt(text)) {
      say("say", "The Session can't take a prompt just now.")
      return
    }
    this.#delegations.push({
      id: delegationId,
      prompt: text,
      at: this.now(),
      before,
      progressAt: -Infinity,
    })
    say("quiet", "Passed to the agent; it is working on it.")
  }

  /** Adds to what was said since the last delegation, a line per turn of either side. */
  #line(role: VoiceLine["role"], delta: string) {
    const last = this.#exchange.at(-1)
    if (last?.role === role) last.text += delta
    else this.#exchange.push({ role, text: delta })
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
        const { prompt, before } = delegation
        // Its prompt's id, from the queue: the Creator's prompt of its text, which no other
        // delegation took.
        if (prompt !== undefined && delegation.promptId === undefined) {
          const queued = (view.queue ?? []).find(
            (entry) =>
              entry.sender.id === view.summary.creator.id &&
              entry.text.trim() === prompt &&
              !this.#delegations.some((other) => other.promptId === entry.id),
          )
          if (queued !== undefined) delegation.promptId = queued.id
        }
        const unclaimed = (turn: TurnView) =>
          !this.#delegations.some((other) => other.turnId === turn.turnId)
        // The Turn its prompt started: by its id, else a new one that holds its text, as one a
        // background agent's notification starts with the prompt riding along. A reply's goes on
        // in the Turn running.
        const started = view.turns.find((turn) =>
          prompt === undefined
            ? turn.end === null && unclaimed(turn)
            : !before.has(turn.turnId) &&
              unclaimed(turn) &&
              (delegation.promptId !== undefined && turn.promptId !== undefined
                ? turn.promptId === delegation.promptId
                : turn.prompt.includes(prompt)),
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

  /** The Turns the Session has now. */
  #turnIds(): ReadonlySet<string> {
    return new Set((this.#view?.turns ?? []).map((turn) => turn.turnId))
  }

  #emit(kind: VoiceEvent["kind"], delegationId: string | null, content: string) {
    this.send({
      kind,
      id: `kndl_${++this.#events}`,
      delegationId: this.sessionWide ? null : delegationId,
      content: clip(content),
    })
  }
}
