// One process serves several pi sessions through the one stream function (a subagent runs a pi
// session of its own). A session's Claude Code conversation is its own: a foreign session, in the
// foreground or background, failing or not, can never claim, resume, rewrite or delete it. Real
// turn sequences through the provider, with Claude Code's query replaced. Ported from
// pi-claude-bridge 0.9.3's unit-cross-session-turns.mjs (MIT, Copyright (c) 2026 Eli Dickinson).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Context, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import { createSession, deleteSession, getSessionPath, openSession } from "cc-session-io"
import { bridgeState, resetBridge, setQuery } from "../../test/BridgeTesting.ts"
import { deliverToolResults, streamClaude } from "./Bridge.ts"
import type { ClaudeQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { ClaudeApi } from "./Names.ts"
import {
  clearSessionStates,
  sessionStateFor,
  setClaudeDir,
  setSessionStateFor,
} from "./SessionMirror.ts"

const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-cross-session-"))
afterAll(() => rmSync(claudeDir, { recursive: true, force: true }))

// The registered model, as pi hands it to the stream function.
let registered: ProviderConfig | undefined
registerClaude(
  {
    on: () => {},
    registerProvider: (_name: string, config: ProviderConfig) => {
      registered = config
    },
  } as unknown as ExtensionAPI,
  [
    {
      provider: "anthropic",
      id: "claude-haiku-5-5",
      label: "Claude Haiku 5.5",
      thinkingLevels: [],
    },
  ],
  {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
      CLAUDE_CONFIG_DIR: claudeDir,
    },
  },
)
const model = {
  ...registered?.models?.[0],
  provider: "anthropic",
  baseUrl: "claude-code",
} as unknown as Model<Api>

// --- A fake query: each turn plays the next script. A function step waits on a gate. ---

interface Script {
  readonly label: string
  readonly steps: ReadonlyArray<Record<string, unknown> | (() => Promise<void>)>
}
const calls: Array<{ label: string; resume: string | undefined }> = []
const scripts: Array<Script> = []

const gate = () => {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { wait: () => promise, open: () => resolve() }
}
const init = (id: string) => ({ type: "system", subtype: "init", session_id: id })
const ev = (event: Record<string, unknown>) => ({ type: "stream_event", event })
const toolUse = (id: string) => [
  ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} },
  }),
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
  }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
  ev({ type: "message_stop" }),
]
const result = (text: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
})

// --- pi's messages, as pi hands them to the stream function ---

let clock = 0
const user = (text: string) => ({ role: "user", content: text, timestamp: clock++ })
const asst = (content: ReadonlyArray<Record<string, unknown>>, stopReason = "stop") => ({
  role: "assistant",
  content,
  api: ClaudeApi,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: clock++,
})
const toolCall = (id: string) =>
  asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse")
const toolResult = (id: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text: "file" }],
  isError: false,
  timestamp: clock++,
})
const say = (text: string) => asst([{ type: "text", text }])

const call = (sessionId: string, messages: ReadonlyArray<unknown>) =>
  streamClaude(model, { messages, tools: [] } as unknown as Context, { sessionId })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const lastResume = () => calls.at(-1)?.resume

beforeEach(() => {
  resetBridge()
  clearSessionStates()
  // Another test file may have pointed the bridge elsewhere.
  setClaudeDir(claudeDir)
  calls.length = 0
  scripts.length = 0
  setQuery(({ options }) => {
    const script = scripts.shift()
    if (!script) throw new Error("no fake script queued")
    calls.push({ label: script.label, resume: options.resume })
    const generator = (async function* () {
      for (const step of script.steps) {
        if (typeof step === "function") {
          await step()
          continue
        }
        // Resuming, Claude Code says it's on the session it resumed.
        yield options.resume && step.type === "system"
          ? { ...step, session_id: options.resume }
          : step
      }
    })()
    return Object.assign(generator, {
      interrupt: async () => {},
      close: () => {},
    }) as unknown as ClaudeQuery
  })
})

afterEach(() => setQuery(null))

describe("cross-session conversation isolation", () => {
  test("a foreground child in the parent's first turn cannot claim the parent's conversation", async () => {
    const P = "pi-parent"
    const C = "pi-child"
    const u1 = user("research X")
    const a1 = toolCall("toolu_P1")
    const tr1 = toolResult("toolu_P1")
    const a2 = say("parent answer")
    const u2 = user("now fix it")
    const gP = gate()

    // The parent's first turn stops at a tool call, held until the child below has run.
    scripts.push({
      label: "P turn 1",
      steps: [init("cc-P"), ...toolUse("toolu_P1"), gP.wait, result("parent answer")],
    })
    const p1 = call(P, [u1])
    await settle()

    scripts.push({ label: "child", steps: [init("cc-C"), result("child answer")] })
    await call(C, [user("child task")]).result()

    gP.open()
    await p1.result()

    scripts.push({ label: "P turn 2", steps: [init("cc-P2"), result("ok")] })
    await call(P, [u1, a1, tr1, a2, u2]).result()

    expect(lastResume()).toBe("cc-P")
  })

  test("a background child finishing after the parent leaves the parent's conversation in place", async () => {
    const P = "pi-parent"
    const C = "pi-child"
    const u1 = user("research X")
    const a2 = say("parent answer")
    const u2 = user("now fix it")
    const gC = gate()

    scripts.push({ label: "P turn 1", steps: [init("cc-P"), result("parent answer")] })
    await call(P, [u1]).result()
    expect(sessionStateFor(P)?.sessionId).toBe("cc-P")

    // The child starts and waits; the parent goes on without it.
    scripts.push({ label: "child", steps: [init("cc-C"), gC.wait, result("child answer")] })
    const child = call(C, [user("child task")])

    scripts.push({ label: "P turn 2", steps: [init("cc-P2"), result("ok")] })
    await call(P, [u1, a2, u2]).result()
    expect(lastResume()).toBe("cc-P")

    gC.open()
    await child.result()

    expect(sessionStateFor(P)?.sessionId).toBe("cc-P")
    expect(sessionStateFor(C)).toMatchObject({ sessionId: "cc-C", piSessionId: C })
  })

  test("a missed steer survives successful completion and rebuilds the next turn", async () => {
    const P = "pi-parent"
    const u1 = user("first")
    const a1 = say("first answer")
    const u2 = user("second")
    const missed = user("missed steer")
    const a2 = say("second answer")
    const u3 = user("third")
    const g = gate()

    scripts.push({ label: "first", steps: [init("cc-missed"), result("first answer")] })
    await call(P, [u1]).result()

    scripts.push({ label: "second", steps: [init("cc-P2"), g.wait, result("second answer")] })
    const second = call(P, [u1, a1, u2])
    await settle()
    expect(lastResume()).toBe("cc-missed")

    // Claude Code has stopped taking input, but still answers. The tool-result path counts the
    // steer before the next turn, so the cursor alone can't bring it back.
    const context = [...bridgeState.activeQueryContexts].find((c) => c.piSessionId === P)
    if (context === undefined || context.promptStream === null)
      throw new Error("the second turn isn't running")
    context.promptStream.fail(new Error("prompt stream closed"))
    await deliverToolResults(context, [], [{ type: "text", text: "missed steer" }], 4)
    const state = sessionStateFor(P)
    if (state === null) throw new Error("no mirror")
    setSessionStateFor(P, { ...state, cursor: 4 })
    context.latestCursor = 4
    expect(sessionStateFor(P)?.needsRebuild).toBe(true)
    g.open()
    await second.result()
    expect(sessionStateFor(P)?.needsRebuild).toBe(true)

    const rebuiltFile = getSessionPath("cc-missed", process.cwd(), claudeDir)
    expect(existsSync(rebuiltFile)).toBe(false)
    scripts.push({ label: "third", steps: [init("cc-P3"), result("third answer")] })
    await call(P, [u1, a1, u2, missed, a2, u3]).result()
    // The next turn imports pi's history, rather than reusing Claude Code's incomplete session.
    expect(existsSync(rebuiltFile)).toBe(true)
    expect(readFileSync(rebuiltFile, "utf8")).toMatch(/missed steer/)
    expect(sessionStateFor(P)?.needsRebuild).toBeFalsy()
  })

  // With the session file there, the next turn keeps it: cut back to where the run began, with
  // pi's messages since written after, Claude Code's own records before staying.
  test("a missed steer is written after the run's start, in the same session", async () => {
    const P = "pi-steer-rewind"
    const u1 = user("first")
    const a1 = say("first answer")
    const u2 = user("second")
    const missed = user("missed steer")
    const a2 = say("second answer")
    const u3 = user("third")
    const g = gate()

    scripts.push({ label: "first", steps: [init("cc-steer"), result("first answer")] })
    await call(P, [u1]).result()
    // What Claude Code wrote for the first turn, an attachment pi never sees with it.
    const written = createSession({ sessionId: "cc-steer", projectPath: process.cwd(), claudeDir })
    written.importMessages(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      ],
      { attachments: [{ afterIndex: 0, attachment: { type: "environment" } }] },
    )
    written.save()

    scripts.push({ label: "second", steps: [init("cc-steer"), g.wait, result("second answer")] })
    const second = call(P, [u1, a1, u2])
    await settle()
    const context = [...bridgeState.activeQueryContexts].find((c) => c.piSessionId === P)
    if (context === undefined || context.promptStream === null)
      throw new Error("the second turn isn't running")
    context.promptStream.fail(new Error("prompt stream closed"))
    await deliverToolResults(context, [], [{ type: "text", text: "missed steer" }], 4)
    g.open()
    await second.result()
    expect(sessionStateFor(P)?.rewindTo).toMatchObject({ sessionId: "cc-steer", cursor: 2 })
    expect(sessionStateFor(P)?.needsRebuild).toBeFalsy()

    scripts.push({ label: "third", steps: [init("cc-steer"), result("third answer")] })
    await call(P, [u1, a1, u2, missed, a2, u3]).result()
    expect(lastResume()).toBe("cc-steer")
    const records = openSession({
      sessionId: "cc-steer",
      projectPath: process.cwd(),
      claudeDir,
    }).records
    expect(records.map((record) => record.type)).toEqual([
      "user",
      "attachment",
      "assistant",
      "user",
      "user",
      "assistant",
    ])
    expect(JSON.stringify(records)).toMatch(/missed steer/)
    deleteSession("cc-steer", process.cwd(), claudeDir)
  })

  test("a missed steer in the first turn rebuilds even without an existing mirror", async () => {
    const P = "pi-first-miss"
    const u1 = user("first")
    const missed = user("missed first-turn steer")
    const a1 = say("first answer")
    const u2 = user("second")
    const g = gate()

    scripts.push({
      label: "first",
      steps: [init("cc-first-missed"), g.wait, result("first answer")],
    })
    const first = call(P, [u1])
    await settle()
    expect(sessionStateFor(P)).toBeNull()

    const context = [...bridgeState.activeQueryContexts].find((c) => c.piSessionId === P)
    if (context === undefined || context.promptStream === null)
      throw new Error("the first turn isn't running")
    context.promptStream.fail(new Error("prompt stream closed"))
    await deliverToolResults(context, [], [{ type: "text", text: "missed first-turn steer" }], 2)
    context.latestCursor = 2
    g.open()
    await first.result()
    expect(sessionStateFor(P)?.needsRebuild).toBe(true)

    const rebuiltFile = getSessionPath("cc-first-missed", process.cwd(), claudeDir)
    expect(existsSync(rebuiltFile)).toBe(false)
    scripts.push({ label: "second", steps: [init("cc-first-missed"), result("second answer")] })
    await call(P, [u1, missed, a1, u2]).result()
    expect(readFileSync(rebuiltFile, "utf8")).toMatch(/missed first-turn steer/)
    expect(sessionStateFor(P)?.needsRebuild).toBeFalsy()
  })

  test("a parent error followed by a child turn does not hand the child the parent's conversation", async () => {
    const P = "pi-parent"
    const C = "pi-child"
    const u1 = user("research X")
    const a2 = say("parent answer")
    const u2 = user("now fix it")

    scripts.push({ label: "P turn 1", steps: [init("cc-P"), result("parent answer")] })
    await call(P, [u1]).result()

    scripts.push({ label: "child during backoff", steps: [init("cc-C"), result("child answer")] })
    await call(C, [user("child task")]).result()

    scripts.push({ label: "P turn 2", steps: [init("cc-P2"), result("ok")] })
    await call(P, [u1, a2, u2]).result()

    expect(lastResume()).toBe("cc-P")
  })
})
