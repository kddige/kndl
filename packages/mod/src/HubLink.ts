// The durable agent's link to the Hub (the protocol's Mod.ts): say hello, post events in batches,
// and long-poll commands. When the Hub answers 409 it has restarted and forgotten the mod, so the
// agent says hello again and polls from `after=0`, the Hub's numbering having started over. Other
// failures are retried with a growing delay.
//
// The transport and scheduling are injected so tests can exercise retries without a server or
// real timers. Posting and polling have their own lifetime, independent of an individual Turn:
// stopping a Turn must not prevent its final events from reaching the Hub.

import { MaxCommandWaitMs } from "@kndl/protocol"
import type { ModCommand } from "@kndl/protocol"
import type { HelloFields } from "./HubMessages.ts"
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
  /**
   * What the hello says; a function is read each time it says hello, as when the Hub restarted
   * since a Session switched its model.
   */
  readonly hello: HelloFields | (() => HelloFields)
  readonly fetch: HubFetch
  /**
   * Calls `fn` once, `ms` from now, independently of the Turn that reported an event.
   */
  readonly after: (ms: number, fn: () => void) => void
  /** Milliseconds since the epoch; `Date.now` by default. */
  readonly now?: () => number
  /**
   * Runs a command from the Hub. Commands run one at a time, in order. Without it the link only
   * reports and never polls.
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
  private isPollingStopped = false
  /** Settles when polling stops, so a poll held at the Hub is let go of at once. */
  private readonly pollingStopped: Promise<"Stopped">
  private stopPoll: () => void = () => undefined
  /** The command being run, if one is. */
  private handling: Promise<void> | undefined
  private isFlushing = false
  /** The flush timer set and not yet fired, and when it is due. */
  private flushTimer: { readonly dueAt: number } | undefined
  private flushFailures = 0
  /** The seq of the last command handled. */
  private after = 0

  constructor(private readonly options: HubLinkOptions) {
    this.pollingStopped = new Promise((resolve) => {
      this.stopPoll = () => resolve("Stopped")
    })
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

  /**
   * Stops taking commands, but not posting: what a process does before it closes what the
   * commands act on. The poll under way is let go of, and a command it brings, or any other of its
   * batch, is never run or acknowledged, so the Hub brings it again to the next link. Resolves once
   * the command being run, if one is, has finished.
   */
  async stopPolling() {
    this.isPollingStopped = true
    this.stopPoll()
    await this.handling
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

  /**
   * Posts everything queued, waiting for a post under way, for at most `ms`: what a process does
   * before it exits, so its last events reach the Hub.
   */
  async drain(ms = 2_000) {
    const deadline = (this.options.now ?? Date.now)() + ms
    while (!this.isStopped && (this.outbox.size > 0 || this.isFlushing)) {
      if ((this.options.now ?? Date.now)() > deadline) return
      if (this.isFlushing) await this.wait(20)
      else await this.flush()
    }
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
        body: helloBody(
          typeof this.options.hello === "function" ? this.options.hello() : this.options.hello,
        ),
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
    while (!this.isStopped && !this.isPollingStopped) {
      if (!this.isGreeted && !(await this.sayHello())) return
      if (this.isPollingStopped) return
      const after = this.after
      let response: { readonly status: number; readonly text: string }
      try {
        const polled = await Promise.race([
          this.options.fetch(`${this.url}/mod/commands?after=${after}&waitMs=${MaxCommandWaitMs}`, {
            method: "GET",
            headers: this.headers,
          }),
          this.pollingStopped,
        ])
        if (polled === "Stopped") return
        response = polled
      } catch (error) {
        if (this.isPollingStopped) return
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
        if (this.isStopped || this.isPollingStopped || seq <= this.after) continue
        let threw = false
        this.handling = (async () => {
          try {
            await onCommand(message)
          } catch (error) {
            threw = true
            this.options.log(`hub-link: ${message._tag} failed: ${error}`)
          }
        })()
        await this.handling
        this.handling = undefined
        // A command that failed because polling stopped under it (what it acts on closed) is
        // left unacknowledged for the Hub to bring again; one that failed otherwise is not.
        if (threw && this.isPollingStopped) return
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
