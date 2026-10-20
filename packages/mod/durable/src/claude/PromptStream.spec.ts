// The streaming input behind mid-turn steering. The consumer here is shaped as the SDK's pump is,
// `for await (const m of stream) { await transport.write(m) }`, which the ack's contract rests on.
//
// Ported from pi-claude-bridge 0.9.3's unit-prompt-stream tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "bun:test"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { makePromptStream, userMessage } from "./PromptStream.ts"

const text = (msg: SDKUserMessage) =>
  (msg.message.content as Array<{ readonly text?: string }>)[0]?.text

const steer = (t: string) => userMessage([{ type: "text", text: t }])

/** Drives the stream as the SDK does: each write awaited before the next message is pulled. */
const pump = (stream: AsyncIterable<SDKUserMessage>, write: (msg: SDKUserMessage) => unknown) =>
  (async () => {
    for await (const msg of stream) await write(msg)
  })()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The message `promise` rejects with, its handler attached at once: one left unhandled until a
 * later await is an unhandled rejection to bun's test runner.
 */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

describe("the prompt stream", () => {
  test("acks a push only once its write completes", async () => {
    const ps = makePromptStream()
    const written: Array<string | undefined> = []
    const { promise: writeGate, resolve: releaseWrite } = Promise.withResolvers<void>()
    const pumping = pump(ps.stream, async (msg) => {
      written.push(text(msg))
      await writeGate
    })

    let acked = false
    const ack = ps.push(steer("steer")).then(() => {
      acked = true
    })

    // The write is in flight: an ack now would let a tool result overtake the steer.
    await sleep(10)
    expect(written).toEqual(["steer"])
    expect(acked).toBe(false)

    releaseWrite()
    await ack
    expect(acked).toBe(true)

    ps.end()
    await pumping
  })

  test("delivers in push order, and ends once drained", async () => {
    const ps = makePromptStream()
    const written: Array<string | undefined> = []
    const pumping = pump(ps.stream, (msg) => {
      written.push(text(msg))
    })

    await ps.push(steer("first"))
    await ps.push(steer("second"))
    ps.end()
    await pumping

    expect(written).toEqual(["first", "second"])
  })

  test("carries the priority to the SDK's message, with no uuid", () => {
    const msg = userMessage([{ type: "text", text: "steer" }], "next")
    expect(msg.priority).toBe("next")
    expect(msg.parent_tool_use_id).toBeNull()
    // A uuid would make Claude Code's stdin loop look the message up in the session.
    expect(msg.uuid).toBeUndefined()
  })

  test("refuses a push after its end, rather than hanging", async () => {
    const ps = makePromptStream()
    const pumping = pump(ps.stream, () => {})
    ps.end()
    await pumping

    await expect(ps.push(steer("late"))).rejects.toThrow(/closed/)
  })

  test("fail() settles the queued and in-flight acks", async () => {
    const ps = makePromptStream()
    // A write that never finishes: a CLI that died mid-write.
    void pump(ps.stream, () => new Promise(() => {})).catch(() => {})

    const inflight = rejection(ps.push(steer("inflight")))
    await sleep(10)
    const queued = rejection(ps.push(steer("queued")))

    ps.fail(new Error("query ended"))
    expect(await inflight).toBe("query ended")
    expect(await queued).toBe("query ended")
    expect(await rejection(ps.push(steer("after")))).toBe("query ended")
  })

  test("settles the ack when the consumer abandons the stream", async () => {
    const ps = makePromptStream()
    // `break` calls gen.return(), which has to run the generator's finally.
    const pumping = (async () => {
      for await (const msg of ps.stream) if (msg) break
    })()

    await expect(ps.push(steer("abandoned"))).rejects.toThrow(/closed/)
    await pumping
  })

  test("refuses a push made after the consumer abandoned the stream", async () => {
    const ps = makePromptStream()
    const pumping = (async () => {
      for await (const msg of ps.stream) if (msg) break
    })()
    await expect(ps.push(steer("abandoned"))).rejects.toThrow(/closed/)
    await pumping

    // Nothing is left to drain the queue: a parked ack would wedge tool-result delivery.
    await expect(
      Promise.race([
        ps.push(steer("later")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("push hung")), 200)),
      ]),
    ).rejects.toThrow(/closed/)
  })

  test("keeps the first failure rather than the last", async () => {
    const ps = makePromptStream()
    // fail() reaches into the generator, so the pump rejects too.
    const pumping = rejection(pump(ps.stream, () => {}))
    const queued = rejection(ps.push(steer("queued")))

    // The provider's catch reports the cause, then its finally fails the stream again.
    ps.fail(new Error("CLI exited with code 1"))
    ps.fail(new Error("query ended"))

    expect(await queued).toBe("CLI exited with code 1")
    expect(await rejection(ps.push(steer("after")))).toBe("CLI exited with code 1")
    expect(await pumping).toBe("CLI exited with code 1")
  })
})
