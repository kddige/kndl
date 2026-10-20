// Compaction: Pi Durable makes each summary with one request marked `cacheRetention: "none"`, on
// the conversation's provider session id, which the bridge routes to a Claude Code of its own, at
// the caller's effort, in the conversation's directory, leaving its Claude Code session alone (the
// Harness's own, in Harness.spec.ts). And the thinking level as Claude Code's effort.
//
// Ported from pi-claude-bridge 0.9.3's unit-compaction-coexistence, unit-summary-cwd and
// unit-isolated-effort tests (MIT, Copyright (c) 2026 Eli Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Api, Context, Model } from "@earendil-works/pi-ai"
import { effortForReasoning } from "./Bridge.ts"
import type { ClaudeQuery, QueryFn } from "./Bridge.ts"
import { ClaudeApi } from "./Names.ts"
import { makeBridge, transcriptOf } from "./testing/BridgeTesting.ts"
import type { TestBridge } from "./testing/BridgeTesting.ts"

let root: string | undefined
let bridge: TestBridge | undefined
afterEach(async () => {
  await bridge?.close()
  bridge = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const useQuery = (query: QueryFn, cwd?: string) => {
  root = mkdtempSync(join(tmpdir(), "kndl-claude-summary-"))
  bridge = makeBridge({ query, claudeDir: join(root, "claude"), ...(cwd ? { cwd } : {}) })
  return bridge
}

/** A query that yields `messages`, recording how it was made. */
const answering =
  (
    calls: Array<{ readonly prompt: unknown; readonly options: Options }>,
    messages: () => ReadonlyArray<Record<string, unknown>>,
  ) =>
  ({ prompt, options }: { prompt: unknown; options: Options }) => {
    calls.push({ prompt, options })
    const generator = (async function* () {
      yield* messages()
    })()
    return Object.assign(generator, {
      interrupt: async () => {},
      close: () => {},
    }) as ClaudeQuery
  }

// --- Effort ---

// Fable 5.1's pi-ai thinkingLevelMap: only xhigh and max named, off unsupported.
const fable = {
  id: "claude-fable-5-1",
  name: "Claude Fable 5.1",
  api: ClaudeApi,
  provider: "anthropic",
  baseUrl: "claude-code",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
} as unknown as Model<Api>
const unmapped = {
  ...fable,
  id: "claude-test-unmapped",
  thinkingLevelMap: undefined,
} as unknown as Model<Api>

describe("effortForReasoning", () => {
  test("takes the model's thinkingLevelMap where it names the level", () => {
    expect(effortForReasoning(fable, "max")).toBe("max")
    expect(effortForReasoning(fable, "xhigh")).toBe("xhigh")
  })

  test("falls back to the table for levels the map leaves unnamed", () => {
    expect(effortForReasoning(fable, "high")).toBe("high")
    expect(effortForReasoning(unmapped, "xhigh")).toBe("max")
    expect(effortForReasoning(unmapped, "max")).toBe("max")
  })

  test("gives no effort for a level the model doesn't take, or none", () => {
    expect(effortForReasoning(fable, "off")).toBeUndefined()
    expect(effortForReasoning(fable, undefined)).toBeUndefined()
  })
})

describe("a summary request", () => {
  // As Pi Durable's compaction makes it: its own system prompt, and one user message.
  const context: Context = {
    systemPrompt: "You are a summarizer.",
    messages: [{ role: "user", content: [{ type: "text", text: "Summarize." }], timestamp: 0 }],
  }

  async function summarize(model: Model<Api>, options: Record<string, unknown>) {
    const calls: Array<{ readonly prompt: unknown; readonly options: Options }> = []
    const summarizing = useQuery(
      answering(calls, () => [
        { type: "result", subtype: "success", is_error: false, result: "summary" },
      ]),
      "/workspace",
    )
    const message = await summarizing
      .streamSimple(model, transcriptOf(context), {
        cacheRetention: "none",
        sessionId: "conversation",
        ...options,
      })
      .result()
    expect(message.stopReason).toBe("stop")
    expect(message.content).toEqual([{ type: "text", text: "summary" }])
    expect(calls.length).toBe(1)
    const [first] = calls
    if (first === undefined) throw new Error("no query")
    // Its conversation's mirror stays as it was: there was none.
    expect(summarizing.mirrors.state("conversation")).toBeNull()
    return first
  }

  test("stopped, as killing its Claude Code ends the query with an error, ends aborted", async () => {
    let killed: ((error: Error) => void) | undefined
    const stopping = useQuery(() => {
      const generator = (async function* () {
        await new Promise<never>((_resolve, reject) => {
          killed = reject
        })
        yield {}
      })()
      return Object.assign(generator, {
        interrupt: async () => {},
        close: () => killed?.(new Error("Claude Code process exited with code 143")),
      }) as ClaudeQuery
    })
    const stop = new AbortController()
    const summary = stopping
      .streamSimple(fable, transcriptOf(context), {
        cacheRetention: "none",
        signal: stop.signal,
      })
      .result()
    await Bun.sleep(10)
    stop.abort()
    const message = await summary
    expect(message.stopReason).toBe("aborted")
    expect(message.errorMessage).toBe("Operation aborted")
  })

  test("runs at the caller's thinking level", async () => {
    expect((await summarize(fable, { reasoning: "max" })).options.effort).toBe("max")
  })

  test("leaves the effort to Claude Code without a thinking level", async () => {
    expect("effort" in (await summarize(fable, {})).options).toBe(false)
  })

  test("keeps no session, runs no tools, and is given its own system prompt whole", async () => {
    const { prompt, options } = await summarize(fable, {})
    expect(prompt).toBe("Summarize.")
    expect(options.persistSession).toBe(false)
    expect(options.resume).toBeUndefined()
    expect(options.tools).toEqual([])
    expect(options.maxTurns).toBe(1)
    expect(options.systemPrompt).toBe("You are a summarizer.")
    expect(options.cwd).toBe("/workspace")
  })

  test("is as long as the caller allows", async () => {
    expect(
      (await summarize(fable, { maxTokens: 4096 })).options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    ).toBe("4096")
    const unlimited = await summarize(fable, {})
    expect(unlimited.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
  })

  test("reports what Claude Code's result says it used", async () => {
    const reporting = useQuery(
      answering([], () => [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "summary",
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      ]),
    )
    const message = await reporting
      .streamSimple(fable, transcriptOf(context), { cacheRetention: "none" })
      .result()
    expect(message.usage).toMatchObject({
      input: 120,
      output: 30,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
    })
  })

  test("starts no query once the bridge is closed", async () => {
    const calls: Array<{ readonly prompt: unknown; readonly options: Options }> = []
    const closing = useQuery(
      answering(calls, () => [
        { type: "result", subtype: "success", is_error: false, result: "summary" },
      ]),
    )
    await closing.close()
    const message = await closing
      .streamSimple(fable, transcriptOf(context), { cacheRetention: "none" })
      .result()
    expect(message.stopReason).toBe("error")
    expect(message.errorMessage).toBe("The Claude bridge is closed")
    expect(calls).toEqual([])
  })

  test("fails with Claude Code's failure, or when it says nothing", async () => {
    const failing = useQuery(
      answering([], () => [
        { type: "result", subtype: "error_during_execution", errors: ["it broke"] },
      ]),
    )
    const message = await failing
      .streamSimple(fable, transcriptOf(context), { cacheRetention: "none" })
      .result()
    expect(message).toMatchObject({ stopReason: "error", errorMessage: "it broke" })
  })
})
