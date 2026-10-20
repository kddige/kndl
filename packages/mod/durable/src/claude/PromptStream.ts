// The long-lived streaming input a Claude Code query is opened with.
//
// The SDK takes `prompt: AsyncIterable<SDKUserMessage>` and pumps it to the CLI's stdin. Keeping
// it open for the life of the query lets a steer be written to stdin while a tool runs, which
// Claude Code drains at the next tool boundary (`priority: "next"`) rather than as a follow-up.
//
// The ack is the load-bearing part: `push()` resolves on the line after `yield`, and the SDK's
// pump is `for await (m of stream) { await transport.write(m) }`, so resuming past the yield
// proves the write completed. Callers await it before releasing the tool's result, which goes
// back over the same stdin, so Claude Code sees the steer first. The drain and that ordering are
// Claude Code internals, not SDK contract.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export interface PromptStream {
  readonly stream: AsyncGenerator<SDKUserMessage>
  /** Queues a message; resolves once the SDK has written it, rejects (never hangs) once ended. */
  readonly push: (msg: SDKUserMessage) => Promise<void>
  /** Closes the input: the generator returns, and the SDK closes the CLI's stdin. */
  readonly end: () => void
  /** Abandons the input, rejecting every queued and in-flight ack. */
  readonly fail: (error: Error) => void
}

export function makePromptStream(): PromptStream {
  interface Item {
    readonly msg: SDKUserMessage
    readonly resolve: () => void
    readonly reject: (e: Error) => void
  }
  const queue: Array<Item> = []
  // The item parked at `yield`, so fail() can settle it: a dying CLI may abandon the pump without
  // resuming us, and an unsettled ack would wedge tool-result delivery.
  let inflight: Item | null = null
  let wake: (() => void) | null = null
  let done = false
  let failure: Error | null = null

  const closed = () => done || failure !== null

  const kick = () => {
    wake?.()
    wake = null
  }

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !closed()) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (failure) throw failure
        const item = queue.shift()
        if (!item) return // ended and drained
        inflight = item
        try {
          yield item.msg
          item.resolve()
        } finally {
          // Normally a no-op (already resolved); when the pump abandons iteration, gen.return()
          // resumes the yield as a return, and this settles the ack.
          item.reject(new Error("prompt stream closed"))
          inflight = null
        }
      }
    } finally {
      // Nothing is left to drain the queue, so nothing would settle a later push.
      done = true
    }
  }

  return {
    stream: gen(),
    push: (msg) =>
      failure || done
        ? Promise.reject(failure ?? new Error("prompt stream closed"))
        : new Promise<void>((resolve, reject) => {
            queue.push({ msg, resolve, reject })
            kick()
          }),
    end: () => {
      done = true
      kick()
    },
    fail: (error) => {
      // The first failure wins: the query's `finally` fails it again with a generic "query ended",
      // which would mask the cause its `catch` recorded.
      if (failure) return
      failure = error
      for (const item of queue.splice(0)) item.reject(error)
      ;(inflight as Item | null)?.reject(error)
      kick()
    },
  }
}

/**
 * A user message for the prompt stream. No `uuid`: none is needed, and one makes Claude Code's
 * stdin loop look the message up in the session.
 */
export function userMessage(
  content: SDKUserMessage["message"]["content"],
  priority?: SDKUserMessage["priority"],
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  }
}
