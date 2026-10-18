// Compaction and branch summaries: pi runs them itself, or an extension does, and the bridge
// routes pi's one-off summary calls (`cacheRetention: "none"`) to a Claude Code of their own, at
// the caller's effort, in the owning session's directory, leaving the Session's own Claude Code
// session alone. Real pi sessions, with only Claude Code's query replaced.
//
// Ported from pi-claude-bridge 0.9.3's unit-compaction-coexistence, unit-summary-cwd and
// unit-isolated-effort tests (MIT, Copyright (c) 2026 Eli Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Api, Context, Model } from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resetBridge, setQuery } from "../../test/BridgeTesting.ts"
import { effortForReasoning, isolatedStreamFn } from "./Bridge.ts"
import type { ClaudeQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { ClaudeApi } from "./Names.ts"
import { clearSessionStates, setClaudeDir } from "./SessionMirror.ts"

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kndl-claude-compaction-"))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  setQuery(null)
  resetBridge()
  clearSessionStates()
  setClaudeDir(undefined)
})

/** A query that yields `messages`, recording how it was made. */
const answering =
  (
    calls: Array<{ readonly prompt: unknown; readonly options: Options }>,
    messages: () => ReadonlyArray<Record<string, unknown>>,
    gate: Promise<void> = Promise.resolve(),
  ) =>
  ({ prompt, options }: { prompt: unknown; options: Options }) => {
    calls.push({ prompt, options })
    const generator = (async function* () {
      await gate
      yield* messages()
    })()
    return Object.assign(generator, {
      interrupt: async () => {},
      close: () => {
        closes.count++
      },
    }) as ClaudeQuery
  }

const closes = { count: 0 }

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

describe("a one-off summary call", () => {
  const context: Context = {
    systemPrompt: "You are an advisor.",
    messages: [{ role: "user", content: [{ type: "text", text: "Advise." }], timestamp: 0 }],
  }

  async function runIsolated(model: Model<Api>, options: Record<string, unknown>) {
    const calls: Array<{ readonly prompt: unknown; readonly options: Options }> = []
    setQuery(
      answering(calls, () => [
        { type: "result", subtype: "success", is_error: false, result: "advice" },
      ]),
    )
    const message = await isolatedStreamFn(model, context, {
      cacheRetention: "none",
      ...options,
    }).result()
    expect(message.stopReason).toBe("stop")
    expect(message.content).toEqual([{ type: "text", text: "advice" }])
    expect(calls.length).toBe(1)
    const [first] = calls
    if (first === undefined) throw new Error("no query")
    return first.options
  }

  test("stopped, as killing its Claude Code ends the query with an error, ends aborted", async () => {
    let killed: ((error: Error) => void) | undefined
    setQuery(() => {
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
    const summary = isolatedStreamFn(fable, context, {
      cacheRetention: "none",
      signal: stop.signal,
    }).result()
    stop.abort()
    const message = await summary
    expect(message.stopReason).toBe("aborted")
    expect(message.errorMessage).toBe("Operation aborted")
  })

  test("runs at the caller's thinking level", async () => {
    expect((await runIsolated(fable, { reasoning: "max" })).effort).toBe("max")
  })

  test("leaves the effort to Claude Code without a thinking level", async () => {
    expect("effort" in (await runIsolated(fable, {}))).toBe(false)
  })

  test("keeps no session, and runs no tools", async () => {
    const options = await runIsolated(fable, {})
    expect(options.persistSession).toBe(false)
    expect(options.tools).toEqual([])
    expect(options.systemPrompt).toBe("You are an advisor.")
  })
})

// --- Real pi sessions ---

const haiku = {
  provider: "anthropic" as const,
  id: "claude-haiku-5-5",
  label: "Claude Haiku 5.5",
  thinkingLevels: [],
}

const model = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  api: ClaudeApi,
  provider: "anthropic",
  baseUrl: "claude-code",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<Api>

const bridge = (pi: ExtensionAPI) =>
  registerClaude(pi, [haiku], {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    },
  })

/** A conversation long enough to compact, each user message marked `owner`. */
function history(cwd: string, owner: string) {
  const manager = SessionManager.inMemory(cwd)
  const targets: Array<string> = []
  for (let turn = 0; turn < 4; turn++) {
    const id = manager.appendMessage({
      role: "user",
      content: `${owner} turn ${turn} ${"context ".repeat(200)}`,
      timestamp: turn * 2,
    })
    if (turn === 0) targets.push(id)
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer ".repeat(200) }],
      api: ClaudeApi,
      provider: "anthropic",
      model: "claude-haiku-5-5",
      stopReason: "stop",
      usage: {
        input: 2000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2200,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: turn * 2 + 1,
    })
  }
  return { manager, targets }
}

const settings = () =>
  SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 50 },
    retry: { enabled: false },
  })

async function startSession(
  cwd: string,
  manager: SessionManager,
  extensions: ReadonlyArray<(pi: ExtensionAPI) => void>,
): Promise<AgentSession> {
  const settingsManager = settings()
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [bridge, ...extensions],
  })
  await loader.reload()
  expect(loader.getExtensions().errors).toEqual([])
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(root, "agent"),
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager,
    noTools: "all",
    model,
  })
  return session
}

async function endSession(session: AgentSession) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
  session.dispose()
}

describe("who compacts", () => {
  for (const owner of ["extension", "native", "declining-extension", "cancel", "error"] as const) {
    test(`compaction owner: ${owner}`, async () => {
      const calls: Array<{ readonly prompt: unknown; readonly options: Options }> = []
      closes.count = 0
      setQuery(
        answering(calls, () => [
          owner === "error"
            ? {
                type: "result",
                subtype: "error_during_execution",
                errors: ["controlled summary failure"],
              }
            : { type: "result", subtype: "success", result: "Controlled native summary" },
        ]),
      )
      const { manager } = history(root, "owner")
      const observed: Array<{ readonly fromExtension?: boolean }> = []
      const session = await startSession(root, manager, [
        (pi) => {
          if (owner !== "native" && owner !== "error")
            pi.on("session_before_compact", (event) => {
              if (owner === "cancel") return { cancel: true }
              if (owner === "declining-extension") return undefined
              return {
                compaction: {
                  summary: "Extension-owned summary",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                  details: { owner: "extension" },
                },
              }
            })
          pi.on("session_compact", (event) => {
            observed.push(event)
          })
        },
      ])
      try {
        if (owner === "cancel" || owner === "error") {
          await expect(session.compact()).rejects.toThrow(
            owner === "cancel" ? /cancelled/ : /controlled summary failure/,
          )
          expect(manager.getBranch().filter((e) => e.type === "compaction").length).toBe(0)
          expect(observed.length).toBe(0)
        } else {
          const compacted = await session.compact()
          expect(compacted.summary).toMatch(
            owner === "extension" ? /Extension-owned summary/ : /Controlled native summary/,
          )
          expect(observed.length).toBe(1)
          expect(observed[0]?.fromExtension).toBe(owner === "extension")
        }
        if (owner === "extension" || owner === "cancel") {
          expect(calls.length).toBe(0)
        } else {
          // A split-turn native compaction summarizes the history and the turn prefix apart.
          expect(calls.length).toBe(owner === "error" ? 1 : 2)
          for (const { options } of calls) {
            expect(options.persistSession).toBe(false)
            expect(options.tools).toEqual([])
            expect(typeof options.systemPrompt).toBe("string")
            expect(String(options.systemPrompt)).toMatch(/summarization/)
          }
          expect(closes.count).toBeGreaterThanOrEqual(calls.length)
        }
      } finally {
        await endSession(session)
      }
    }, 15_000)
  }
})

describe("concurrent summaries", () => {
  for (const operation of ["compaction", "branch summary"] as const) {
    test(`a native ${operation}'s Claude Code runs in its own session's directory`, async () => {
      const cwds = [mkdtempSync(join(root, "one-")), mkdtempSync(join(root, "two-"))]
      const calls: Array<{ readonly prompt: unknown; readonly options: Options }> = []
      const { promise: queriesStarted, resolve: releaseQueries } = Promise.withResolvers<void>()
      const expected = operation === "compaction" ? 4 : 2
      setQuery((params) => {
        const query = answering(
          calls,
          () => [{ type: "result", subtype: "success", result: "Controlled native summary" }],
          queriesStarted,
        )(params as { prompt: unknown; options: Options })
        if (calls.length === 2) releaseQueries()
        return query
      })
      // Both sessions enter their before hook before either may start its query.
      let entered = 0
      const { promise: hooksEntered, resolve: releaseHooks } = Promise.withResolvers<void>()
      const enter = async () => {
        if (++entered === 2) releaseHooks()
        await hooksEntered
      }
      const sessions: Array<AgentSession> = []
      const targets: Array<string> = []
      try {
        for (const [i, cwd] of cwds.entries()) {
          const { manager, targets: own } = history(cwd, `owner-${i}`)
          targets.push(...own)
          const session = await startSession(cwd, manager, [
            (pi) => {
              if (operation === "compaction") pi.on("session_before_compact", enter)
              else pi.on("session_before_tree", enter)
            },
          ])
          sessions.push(session)
          await session.bindExtensions({
            onError: (error) => {
              throw new Error(error.error)
            },
          })
        }
        await Promise.all(
          sessions.map((session, i) =>
            operation === "compaction"
              ? session.compact()
              : session.navigateTree(targets[i] ?? "", { summarize: true }),
          ),
        )
        expect(calls.length).toBe(expected)
        for (const [i, cwd] of cwds.entries()) {
          const owned = calls.filter(({ prompt }) => String(prompt).includes(`owner-${i}`))
          expect(owned.length).toBe(expected / 2)
          for (const { options } of owned) expect(options.cwd).toBe(cwd)
        }
      } finally {
        for (const session of sessions) await endSession(session)
      }
    }, 15_000)
  }
})
