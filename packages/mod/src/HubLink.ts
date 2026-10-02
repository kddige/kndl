// The mod's link to the Hub (the protocol's Mod.ts): say hello, post Turn events in batches, and
// long-poll for commands. When the Hub answers 409 it has restarted and forgotten the mod, so the
// mod says hello again and polls from `after=0`, the Hub's numbering having started over. Other
// failures are retried with a growing delay.
//
// It runs on what it is given (`fetch`, `sleep`), so the same code runs in Claude Code's mod
// runtime, which has no timers of its own, and under `bun test`.

import { MaxCommandWaitMs } from "@claude-hub/protocol"
import type { ModCommand } from "@claude-hub/protocol"
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
  readonly sleep: (ms: number) => Promise<void>
  /** Runs a command from the Hub. Commands run one at a time, in order. */
  readonly onCommand: (command: ModCommand) => Promise<void>
  readonly onStatus: (status: LinkStatus) => void
  readonly log: (text: string) => void
  /** How long events wait to be batched; 100 ms by default. */
  readonly flushDelayMs?: number
}

/** How long to wait after the `attempt`th failure in a row: 1 s, doubling, at most 30 s. */
export const retryDelay = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000)

type HelloOutcome = "Welcomed" | "Retry" | { readonly rejected: string }

export class HubLink {
  private readonly outbox = new Outbox()
  private readonly url: string
  private readonly headers: Record<string, string>
  private greeting: Promise<boolean> | undefined
  private isGreeted = false
  private isStopped = false
  private isFlushing = false
  private isFlushScheduled = false
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

  /** Says hello and starts polling for commands. */
  start() {
    this.options.onStatus({ _tag: "Linking" })
    void this.pollLoop()
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
        await this.options.sleep(retryDelay(attempt++))
      }
      return false
    })().finally(() => {
      this.greeting = undefined
    })
    return this.greeting
  }

  private async pollLoop() {
    let failures = 0
    const failed = async (why: string) => {
      if (failures === 0) this.options.log(`hub-link: polling for commands failed: ${why}`)
      this.options.onStatus({ _tag: "Offline" })
      await this.options.sleep(retryDelay(failures++))
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
          await this.options.onCommand(message)
        } catch (error) {
          this.options.log(`hub-link: ${message._tag} failed: ${error}`)
        }
        this.after = seq
      }
    }
  }

  private scheduleFlush(delayMs = this.options.flushDelayMs ?? 100) {
    if (this.isFlushScheduled || this.isStopped) return
    this.isFlushScheduled = true
    void (async () => {
      await this.options.sleep(delayMs)
      this.isFlushScheduled = false
      await this.flush()
    })()
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
    if (this.outbox.size > 0) this.scheduleFlush(retryIn || undefined)
  }
}
