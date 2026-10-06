// A plugin's link to the Hub (the protocol's Mod.ts): say hello, post events in batches, and, for
// the plugin that runs the Hub's commands, long-poll for them. When the Hub answers 409 it has restarted and forgotten the mod, so the
// mod says hello again and polls from `after=0`, the Hub's numbering having started over. Other
// failures are retried with a growing delay.
//
// It runs on what it is given (`fetch`, `after`), so the same code runs in Claude Code's mod
// runtime, which has no timers of its own, and under `bun test`.
//
// All of its work runs from its own timers, never inside the hook that reported an event. In
// Claude Code a `$` call belongs to the hook's dispatch it was made in, wherever its `$` came from,
// and once a Stop aborts the Turn, each wait or fetch made in that dispatch is refused at once
// ("turn-abort"). A `tool.call` hook reports its call's end after the abort, so a flush waited
// for there was refused, and the link never posted again (#165).

import { MaxCommandWaitMs } from "@kndl/protocol"
import type { ModCommand } from "@kndl/protocol"
import {
  checkEvent,
  eventsBody,
  helloBody,
  Outbox,
  readCommands,
  readHelloReply,
} from "./HubMessages.ts"

export type HubFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST"
    readonly headers: Record<string, string>
    readonly body?: string
  },
) => Promise<{ readonly status: number; readonly text: string }>

/** Where the link stands, for the band. */
export type LinkStatus =
  | { readonly _tag: "Linking" }
  | { readonly _tag: "Linked" }
  | { readonly _tag: "Offline" }
  | { readonly _tag: "Rejected"; readonly reason: string }

export interface HubLinkOptions {
  /** The Hub's base URL. */
  readonly hubUrl: string
  /** The Session's mod token. */
  readonly modToken: string
  /** What the hello says. */
  readonly hello: {
    readonly sessionId: string
    readonly claudeSessionId: string
    readonly model: string
  }
  readonly fetch: HubFetch
  /**
   * Calls `fn` once, `ms` from now, on its own: not in the dispatch of the hook that asked, which a
   * Turn abort cuts short. In Claude Code, `$.clock.after`.
   */
  readonly after: (ms: number, fn: () => void) => void
  /** Milliseconds since the epoch; `Date.now` by default. */
  readonly now?: () => number
  /**
   * Runs a command from the Hub. Commands run one at a time, in order. Without it the link only
   * reports, and never polls: one plugin of the two runs the commands (ADR 0014).
   */
  readonly onCommand?: (command: ModCommand) => Promise<void>
  readonly onStatus: (status: LinkStatus) => void
  readonly log: (text: string) => void
  /** How long events wait to be batched; 100 ms by default. */
  readonly flushDelayMs?: number
}

/** How long to wait after the `attempt`th failure in a row: 1 s, doubling, at most 30 s. */
export const retryDelay = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000)

/** A flush timer this long past its time never fired, so the next event schedules another. */
export const LostTimerMs = 10_000

type HelloOutcome = "Welcomed" | "Retry" | { readonly rejected: string }

export class HubLink {
  private readonly outbox = new Outbox()
  private readonly url: string
  private readonly headers: Record<string, string>
  private greeting: Promise<boolean> | undefined
  private isGreeted = false
  private isStopped = false
  private isFlushing = false
  /** The flush timer set and not yet fired, and when it is due. */
  private flushTimer: { readonly dueAt: number } | undefined
  private flushFailures = 0
  /** The seq of the last command handled. */
  private after = 0

  constructor(private readonly options: HubLinkOptions) {
    this.url = options.hubUrl.replace(/\/+$/, "")
    this.headers = {
      authorization: `Bearer ${options.modToken}`,
      "content-type": "application/json",
    }
  }

  /** Says hello and starts polling for commands, if it runs them, from a timer of its own. */
  start() {
    this.options.onStatus({ _tag: "Linking" })
    const begin = () =>
      void (this.options.onCommand === undefined ? this.sayHello() : this.pollLoop())
    if (!this.later(0, begin)) begin()
  }

  /** Stops polling and posting. */
  stop() {
    this.isStopped = true
  }

  /** Queues an event for the Hub. One that doesn't fit the protocol is logged and dropped. */
  report(event: unknown) {
    if (this.isStopped) return
    const checked = checkEvent(event)
    if (checked._tag === "Invalid") {
      this.options.log(`hub-link: dropped an event the protocol rejects: ${checked.reason}`)
      return
    }
    this.outbox.push(checked.event)
    this.scheduleFlush()
  }

  /** Posts what is queued now, as when the session ends. */
  async flushNow() {
    await this.flush()
  }

  private stopRejected(reason: string) {
    this.isStopped = true
    this.options.onStatus({ _tag: "Rejected", reason })
    this.options.log(`hub-link: the Hub refused the link: ${reason}`)
  }

  private async helloOnce(): Promise<HelloOutcome> {
    let response: { readonly status: number; readonly text: string }
    try {
      response = await this.options.fetch(`${this.url}/mod/hello`, {
        method: "POST",
        headers: this.headers,
        body: helloBody(this.options.hello),
      })
    } catch (error) {
      this.options.log(`hub-link: hello failed: ${error}`)
      return "Retry"
    }
    if (response.status === 401 || response.status === 403)
      return { rejected: `the Hub refused the mod token (${response.status})` }
    const reply = readHelloReply(response.text)
    if (reply?._tag === "ModWelcome") return "Welcomed"
    if (reply?._tag === "HandshakeRejected") return { rejected: reply.message }
    this.options.log(`hub-link: the Hub answered the hello with ${response.status}`)
    return "Retry"
  }

  /** Says hello until the Hub welcomes the mod; false when it refuses or the link stopped. */
  private sayHello(): Promise<boolean> {
    this.greeting ??= (async () => {
      let attempt = 0
      while (!this.isStopped) {
        const outcome = await this.helloOnce()
        if (outcome === "Welcomed") {
          // A hello after the first means the Hub started over, and so did its numbering.
          this.after = 0
          this.isGreeted = true
          this.options.onStatus({ _tag: "Linked" })
          return true
        }
        if (outcome !== "Retry") {
          this.stopRejected(outcome.rejected)
          return false
        }
        this.options.onStatus({ _tag: "Offline" })
        await this.wait(retryDelay(attempt++))
      }
      return false
    })().finally(() => {
      this.greeting = undefined
    })
    return this.greeting
  }

  private async pollLoop() {
    const onCommand = this.options.onCommand
    if (onCommand === undefined) return
    let failures = 0
    const failed = async (why: string) => {
      if (failures === 0) this.options.log(`hub-link: polling for commands failed: ${why}`)
      this.options.onStatus({ _tag: "Offline" })
      await this.wait(retryDelay(failures++))
    }
    while (!this.isStopped) {
      if (!this.isGreeted && !(await this.sayHello())) return
      const after = this.after
      let response: { readonly status: number; readonly text: string }
      try {
        response = await this.options.fetch(
          `${this.url}/mod/commands?after=${after}&waitMs=${MaxCommandWaitMs}`,
          { method: "GET", headers: this.headers },
        )
      } catch (error) {
        await failed(String(error))
        continue
      }
      if (response.status === 409) {
        this.isGreeted = false
        continue
      }
      if (response.status === 401 || response.status === 403) {
        this.stopRejected(`the Hub refused the mod token (${response.status})`)
        return
      }
      const commands = response.status === 200 ? readCommands(response.text) : undefined
      if (commands === undefined) {
        await failed(`the Hub answered ${response.status}`)
        continue
      }
      if (failures > 0) this.options.onStatus({ _tag: "Linked" })
      failures = 0
      // A hello while this poll was out started the numbering over: this answer is stale.
      if (this.after !== after) continue
      for (const { seq, message } of commands.messages) {
        if (this.isStopped || seq <= this.after) continue
        try {
          await onCommand(message)
        } catch (error) {
          this.options.log(`hub-link: ${message._tag} failed: ${error}`)
        }
        this.after = seq
      }
    }
  }

  /** Runs `fn` from a timer, `ms` from now; false if the timer couldn't be set. */
  private later(ms: number, fn: () => void): boolean {
    try {
      this.options.after(ms, fn)
      return true
    } catch (error) {
      this.options.log(`hub-link: couldn't set a timer: ${error}`)
      return false
    }
  }

  /** Waits `ms`; at once if the timer couldn't be set. */
  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      if (!this.later(ms, resolve)) resolve()
    })
  }

  private scheduleFlush(delayMs = this.options.flushDelayMs ?? 100, isRetry = false) {
    if (this.isStopped) return
    const now = (this.options.now ?? Date.now)()
    // One flush timer at a time, unless it never fired.
    if (this.flushTimer !== undefined && now < this.flushTimer.dueAt + LostTimerMs) return
    const timer = { dueAt: now + delayMs }
    this.flushTimer = timer
    const fire = () => {
      // A timer replaced as lost does nothing if it fires after all.
      if (this.flushTimer !== timer) return
      this.flushTimer = undefined
      void this.flush()
    }
    if (this.later(delayMs, fire)) return
    // Post now instead, but not as a retry: one that failed would only fail again, at once.
    this.flushTimer = undefined
    if (!isRetry) void this.flush()
  }

  private async flush() {
    if (this.isFlushing || this.isStopped || this.outbox.size === 0) return
    this.isFlushing = true
    let retryIn = 0
    try {
      if (!this.isGreeted && !(await this.sayHello())) return
      const batch = this.outbox.take()
      let status: number
      try {
        status = (
          await this.options.fetch(`${this.url}/mod/events`, {
            method: "POST",
            headers: this.headers,
            body: eventsBody(batch),
          })
        ).status
      } catch (error) {
        if (this.flushFailures === 0) this.options.log(`hub-link: posting events failed: ${error}`)
        status = 0
      }
      if (status >= 200 && status < 300) {
        if (this.flushFailures > 0) this.options.onStatus({ _tag: "Linked" })
        this.flushFailures = 0
      } else if (status === 409) {
        this.isGreeted = false
        this.outbox.putBack(batch)
      } else if (status === 400) {
        // Every event was checked against the protocol, so this is a Hub on another version.
        this.options.log(`hub-link: the Hub refused ${batch.length} events as malformed`)
      } else if (status === 401 || status === 403) {
        this.stopRejected(`the Hub refused the mod token (${status})`)
      } else {
        this.outbox.putBack(batch)
        this.options.onStatus({ _tag: "Offline" })
        retryIn = retryDelay(this.flushFailures++)
      }
    } finally {
      this.isFlushing = false
    }
    if (this.outbox.size > 0) this.scheduleFlush(retryIn || undefined, true)
  }
}
