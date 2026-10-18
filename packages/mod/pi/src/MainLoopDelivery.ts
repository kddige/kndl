// What a pi Session's main loop is given from outside it: the Hub's prompts (DeliverPrompt), the
// prompts the Creator steers into the running Turn (DeliverIntoTurn, ADR 0018), and the results
// of the subagents it didn't wait for, each of which starts a Turn from its agent (ADR 0014).
//
// A prompt or a result goes only while pi is idle, one run each, results first, oldest first:
// never into a run, and not into pi's own follow-up queue, which its terminal empties when the
// person stops a run there, and which an aborted run leaves waiting. One that comes while pi is
// busy waits here, and goes once pi has settled, after pi's own handling of its settling is over,
// or at the next look, every quarter of a second.
//
// pi takes a prompt or a message without saying whether it ran it: one it refuses (an input
// handler that handled it, a run that failed to start) starts no Turn, and says so only in its
// own log. So what was given to pi and hasn't started its Turn once pi has stayed idle for a
// second is given up on: a prompt is reported failed (PromptFailed) and no longer said to be
// given (#323), so the Hub may deliver it again; a result is left for the next start of pi, which
// gives the main loop again those it never took (Subagents.ts).
//
// It takes pi in plain shapes, so it runs under `bun test` without pi.

import { deliveredPrompt, steeredPrompt } from "../../src/HubMessages.ts"
import type { Command } from "../../src/HubMessages.ts"
import type { AgentResultMessage, NextRun, Turns } from "./Turns.ts"

/** pi's main loop, as it is given things. */
export interface MainLoop {
  /** Whether pi is idle: no run, compaction or summary. */
  readonly isIdle: () => boolean
  /** Why pi can't run a prompt now, if it can't: it has no model, or no credential for it. */
  readonly cannotRun: () => string | undefined
  /** Gives pi a prompt, as a user message, which starts a run. */
  readonly prompt: (text: string) => void
  /** Gives pi an agent's result, as a message of the extension's own, which starts a run. */
  readonly result: (result: AgentResultMessage) => void
  /** Puts a steered prompt into the running Turn, before its next request. */
  readonly steer: (promptId: string, text: string) => void
  /** Records, in pi's session, that the prompt was given to pi, or wasn't after all (#323). */
  readonly record: (promptId: string, submitted: boolean) => void
}

export interface MainLoopDeliveryOptions {
  /** The main loop's Turns, which say when a prompt from the Hub started its Turn. */
  readonly turns: Turns
  readonly report: (event: Record<string, unknown>) => void
  /** Whether the Hub takes PromptAlreadySubmitted (#323): one from before would refuse it. */
  readonly takesAlreadySubmitted: () => boolean
  /** The main loop took an agent's result: the Turn it starts has started. */
  readonly resultTaken: (result: AgentResultMessage) => void
  /** Calls `fn` every `ms` milliseconds, until the function it returns is called. */
  readonly every: (ms: number, fn: () => void) => () => void
  /** Calls `fn` once the event being handled now is over: in a later task. */
  readonly soon: (fn: () => void) => void
  /** The extension's log. */
  readonly log: (text: string) => void
}

/** How often it looks again at a pi that was busy, in milliseconds. */
export const lookEvery = 250

/** How many looks in a row pi may be idle without starting what it was given, before giving up. */
export const idleLooksBeforeGivingUp = 4

/** What was given to pi, until its Turn starts. */
type Given =
  | { readonly kind: "prompt"; readonly promptId: string; idleLooks: number }
  | { readonly kind: "result"; readonly result: AgentResultMessage; idleLooks: number }

export class MainLoopDelivery {
  private loop: MainLoop | undefined
  /** The prompts from the Hub pi was given (true) or failed to take (false), by id (#323). */
  private readonly submitted = new Map<string, boolean>()
  /** A prompt from the Hub that came while pi was busy, to give it once pi is idle. */
  private waiting: Command<"DeliverPrompt"> | undefined
  /** Agents' results waiting for the main loop to be idle, oldest first. */
  private readonly results: Array<AgentResultMessage> = []
  /** What was given to pi last, until its Turn starts. */
  private given: Given | undefined
  private stopLooking: (() => void) | undefined

  constructor(private readonly options: MainLoopDeliveryOptions) {}

  /**
   * pi's session started, and this is its main loop: `submitted` are the prompts it was given, or
   * failed to take, as its session recorded them.
   */
  attach(loop: MainLoop, submitted: Iterable<readonly [string, boolean]>) {
    this.detach()
    this.loop = loop
    for (const [promptId, isSubmitted] of submitted) this.submitted.set(promptId, isSubmitted)
  }

  /**
   * pi's session is ending: nothing more is given to it. The Hub delivers its prompt again once
   * pi is back, and Subagents the results; a prompt pi was given that never started its Turn is
   * recorded as not given, so it runs then.
   */
  detach() {
    const given = this.given
    if (given?.kind === "prompt" && this.options.turns.yetToStart(given.promptId))
      this.record(given.promptId, false)
    this.loop = undefined
    this.submitted.clear()
    this.waiting = undefined
    this.results.length = 0
    this.given = undefined
    this.look()
  }

  /** A prompt from the Prompt queue: given to pi now if it is idle, else once it is. */
  prompt(command: Command<"DeliverPrompt">) {
    const { promptId } = command
    if (this.submitted.get(promptId) === true) {
      // A Hub from before #323 would refuse the event, so it keeps the prompt queued: still run once.
      if (this.options.takesAlreadySubmitted())
        this.options.report({ _tag: "PromptAlreadySubmitted", promptId })
      return
    }
    if (this.loop === undefined) return this.failed(promptId, "pi's session hasn't started")
    this.waiting = command
    this.next()
  }

  /**
   * An agent's result: given to the main loop once it is idle, after those before it, and never
   * in the middle of handling another event (as pi's session starting, when Subagents gives again
   * the results the main loop hadn't taken).
   */
  result(result: AgentResultMessage) {
    this.results.push(result)
    this.options.soon(() => this.next())
    this.look()
  }

  /**
   * A queued prompt the Creator steered into the running Turn (ADR 0018): a message pi puts into
   * the conversation before the run's next request, as it does a message typed while it works.
   */
  steer(command: Command<"DeliverIntoTurn">) {
    const { promptId, sender, text } = command
    const attachments = command.attachments ?? []
    const loop = this.loop
    if (this.options.turns.turnId === undefined || loop === undefined || loop.isIdle())
      return this.options.report({ _tag: "PromptFailed", promptId, message: "no Turn is running" })
    try {
      loop.steer(promptId, steeredPrompt(sender, text, attachments))
    } catch (error) {
      return this.options.report({ _tag: "PromptFailed", promptId, message: String(error) })
    }
    this.options.turns.steered({ promptId, sender, text, attachments })
  }

  /** A run started, as Turns says it did: with what was given to pi, maybe. */
  started(run: NextRun | undefined) {
    const result = run?.agentResult
    if (result !== undefined) this.options.resultTaken(result)
    const given = this.given
    if (
      given !== undefined &&
      (given.kind === "prompt"
        ? run?.from?.promptId === given.promptId
        : result?.agentId === given.result.agentId && result.text === given.result.text)
    )
      this.given = undefined
  }

  /**
   * pi settled (`agent_settled`): what waited for it goes once pi's handling of the settling is
   * over, so that pi neither defers it nor drops what it deferred after it, should it refuse it.
   */
  settled() {
    this.options.soon(() => this.next())
  }

  private busy(loop: MainLoop) {
    return !loop.isIdle() || this.options.turns.turnId !== undefined
  }

  /** Gives pi the next of what waits, if it is idle and has started what it was given last. */
  private next() {
    const loop = this.loop
    if (loop !== undefined && this.given === undefined && !this.busy(loop)) {
      const result = this.results.shift()
      if (result !== undefined) this.giveResult(loop, result)
      else if (this.waiting !== undefined) {
        const command = this.waiting
        this.waiting = undefined
        this.givePrompt(loop, command)
      }
    }
    this.look()
  }

  /** Looks again every so often while something waits, or was given to pi and hasn't started. */
  private look() {
    const needed =
      this.loop !== undefined &&
      (this.given !== undefined || this.waiting !== undefined || this.results.length > 0)
    if (!needed) {
      this.stopLooking?.()
      this.stopLooking = undefined
    } else this.stopLooking ??= this.options.every(lookEvery, () => this.looked())
  }

  /** A look: what pi was given and hasn't started is given up on once pi stays idle; then next. */
  private looked() {
    const given = this.given
    const loop = this.loop
    if (given !== undefined && loop !== undefined) {
      if (this.busy(loop)) given.idleLooks = 0
      else if (++given.idleLooks >= idleLooksBeforeGivingUp) this.givenUp(given)
    }
    this.next()
  }

  private givenUp(given: Given) {
    this.given = undefined
    if (given.kind === "prompt") return this.failed(given.promptId, "pi didn't run it")
    this.options.log(
      `kndl: pi didn't run agent ${given.result.agentId}'s result; it is given again when pi starts again`,
    )
  }

  private givePrompt(loop: MainLoop, command: Command<"DeliverPrompt">) {
    const { promptId } = command
    const cannot = loop.cannotRun()
    if (cannot !== undefined) return this.failed(promptId, cannot)
    const attachments = command.attachments ?? []
    const text = deliveredPrompt(command.sender, command.text, attachments)
    this.record(promptId, true)
    this.options.turns.deliver({ promptId, sender: command.sender, text, attachments })
    this.given = { kind: "prompt", promptId, idleLooks: 0 }
    try {
      loop.prompt(text)
    } catch (error) {
      this.given = undefined
      this.failed(promptId, String(error))
    }
  }

  private giveResult(loop: MainLoop, result: AgentResultMessage) {
    this.given = { kind: "result", result, idleLooks: 0 }
    try {
      loop.result(result)
    } catch (error) {
      this.given = undefined
      this.options.log(`kndl: couldn't give pi agent ${result.agentId}'s result: ${String(error)}`)
    }
  }

  /** The prompt wasn't given to pi after all: it starts no Turn, and the Hub hears why. */
  private failed(promptId: string, message: string) {
    this.options.turns.deliveryFailed(promptId)
    if (this.submitted.has(promptId)) this.record(promptId, false)
    this.options.report({ _tag: "PromptFailed", promptId, message })
  }

  private record(promptId: string, isSubmitted: boolean) {
    this.submitted.set(promptId, isSubmitted)
    try {
      this.loop?.record(promptId, isSubmitted)
    } catch (error) {
      this.options.log(`kndl: couldn't record prompt ${promptId}: ${String(error)}`)
    }
  }
}
