import { expect, test } from "bun:test"
import {
  liveVoiceModel,
  liveVoiceModeOf,
  type OpenQuestion,
  type SessionSummary,
} from "@kndl/protocol"
import type { TurnView } from "../src/hub/transcript.ts"
import { type SessionView, VoiceBridge, type VoiceEvent } from "../src/session/voiceBridge.ts"
import { heardEvent, toolOutput } from "../src/session/voiceProtocol.ts"
import { runVoiceTool, type ToolHost } from "../src/session/voiceTools.ts"

const summary = (extra: Partial<SessionSummary> = {}) =>
  ({ id: "s1", state: "Active", currentTurn: null, ...extra }) as unknown as SessionSummary

const turn = (prompt: string, blocks: TurnView["blocks"], ended: boolean): TurnView =>
  ({
    turnId: `t-${prompt}`,
    seq: 1,
    at: 1,
    prompt,
    blocks,
    stopRequests: [],
    unread: [],
    end: ended ? { reason: "stop" } : null,
  }) as unknown as TurnView

const question = {
  turnId: "t",
  toolCallId: "q1",
  questions: [
    {
      question: "Which database?",
      header: "DB",
      options: [{ label: "SQLite" }],
      multiSelect: false,
    },
  ],
  askedAt: 1,
} as unknown as OpenQuestion

function host(view: SessionView) {
  const did: Array<string> = []
  const tools: ToolHost = {
    view: () => view,
    sendToAgent: (prompt) => (did.push(`send ${prompt}`), true),
    answer: (_question, text) => (did.push(`answer ${text}`), true),
    stop: () => (did.push("stop"), true),
  }
  return { tools, did }
}

const run = (name: string, args: unknown, tools: ToolHost) =>
  JSON.parse(runVoiceTool(name, JSON.stringify(args), tools)) as Record<string, unknown>

test("send_to_agent gives the agent the reasoning model's instruction", () => {
  const { tools, did } = host({ summary: summary(), turns: [] })
  expect(run("send_to_agent", { prompt: "  Fix the failing parser test  " }, tools)).toMatchObject({
    sent: true,
  })
  expect(did).toEqual(["send Fix the failing parser test"])
  expect(run("send_to_agent", { prompt: " " }, tools)).toHaveProperty("error")
})

test("agent_status says what the agent is doing, and what it asks", () => {
  const running = turn(
    "Run the tests",
    [{ kind: "tool", key: "k", call: { tool: "Bash", input: '{"command":"bun test"}' } } as never],
    false,
  )
  const { tools } = host({
    summary: summary({ currentTurn: "t" as never, openQuestion: question }),
    turns: [running],
    queue: [{} as never],
  })
  expect(run("agent_status", {}, tools)).toEqual({
    state: "Active",
    working: true,
    workingOn: "Run the tests",
    latestTool: 'Bash {"command":"bun test"}',
    asks: [{ question: "Which database?", options: ["SQLite"] }],
    queuedPrompts: 1,
  })
})

test("read_agent_history gives the latest Turns, with their answers", () => {
  const { tools } = host({
    summary: summary(),
    turns: [
      turn("One", [{ kind: "text", key: "a", text: "First." }], true),
      turn("Two", [{ kind: "text", key: "b", text: "Second." }], true),
      turn("Three", [], false),
    ],
  })
  expect(JSON.parse(runVoiceTool("read_agent_history", '{"turns":2}', tools))).toEqual([
    { asked: "Two", answered: "Second." },
    { asked: "Three", status: "running" },
  ])
})

test("answer_agent_question and stop_agent act only when there is something to act on", () => {
  const idle = host({ summary: summary(), turns: [] })
  expect(run("answer_agent_question", { answer: "SQLite" }, idle.tools)).toHaveProperty("error")
  expect(run("stop_agent", {}, idle.tools)).toMatchObject({ stopped: false })
  expect(idle.did).toEqual([])

  const busy = host({
    summary: summary({ currentTurn: "t" as never, openQuestion: question }),
    turns: [],
  })
  expect(run("answer_agent_question", { answer: "SQLite" }, busy.tools)).toEqual({ answered: true })
  expect(run("stop_agent", {}, busy.tools)).toEqual({ stopped: true })
  expect(busy.did).toEqual(["answer SQLite", "stop"])
  expect(run("rm_rf", {}, busy.tools)).toHaveProperty("error")
})

test("a function call the reasoning model makes is read from GPT-Live's forwarded event", () => {
  const call = {
    type: "response.event",
    delegation_id: "d1",
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "send_to_agent",
        arguments: '{"prompt":"x"}',
      },
    },
  }
  for (const protocol of ["Live", "Codex"] as const) {
    expect(heardEvent(protocol, JSON.stringify(call))).toEqual({
      kind: "toolCall",
      callId: "call_1",
      name: "send_to_agent",
      arguments: '{"prompt":"x"}',
    })
  }
  // Text the model writes is GPT-Live's to say, not a call: a sign the model is at work.
  expect(
    heardEvent(
      "Live",
      JSON.stringify({ ...call, event: { type: "response.output_text.delta", delta: "Hi" } }),
    ),
  ).toEqual({ kind: "reasoning" })
  expect(toolOutput("call_1", '{"sent":true}', "k")).toEqual([
    {
      type: "response.item.create",
      event_id: "k_output",
      item: { type: "function_call_output", call_id: "call_1", output: '{"sent":true}' },
    },
    { type: "response.create", event_id: "k_continue" },
  ])
})

test("a prompt the reasoning model sends is followed to its answer, said to the conversation", () => {
  const sent: Array<VoiceEvent> = []
  const prompts: Array<string> = []
  const bridge = new VoiceBridge(
    { sendPrompt: (text) => (prompts.push(text), true), reply: () => true },
    (event) => sent.push(event),
  )
  bridge.sessionWide = true
  bridge.observe({ summary: summary(), turns: [] })
  expect(bridge.prompt("Fix the build")).toBe(true)
  expect(prompts).toEqual(["Fix the build"])
  bridge.observe({
    summary: summary(),
    turns: [turn("Fix the build", [{ kind: "text", key: "a", text: "Fixed." }], true)],
  })
  expect(sent.at(-1)).toEqual({
    kind: "say",
    id: expect.any(String),
    // For the conversation, not one of GPT-Live's delegations.
    delegationId: null,
    content: "The agent finished. Its answer: Fixed.",
  })
})

test("a reasoning model works behind the voice only where the Model can have one", () => {
  const chatgpt = liveVoiceModel("openai/gpt-live-1-codex")
  const api = liveVoiceModel("openai/gpt-live-1")
  if (chatgpt === undefined || api === undefined) throw new Error("no such Model")
  // Through ChatGPT: Talk only, whatever is asked.
  expect(liveVoiceModeOf(undefined, chatgpt)).toBe("Talk")
  expect(liveVoiceModeOf({ model: chatgpt.name, mode: "Reasoning" }, chatgpt)).toBe("Talk")
  // Through the API: a reasoning model unless Talk only is chosen.
  expect(liveVoiceModeOf(undefined, api)).toBe("Reasoning")
  expect(liveVoiceModeOf({ model: api.name, mode: "Talk" }, api)).toBe("Talk")
})
