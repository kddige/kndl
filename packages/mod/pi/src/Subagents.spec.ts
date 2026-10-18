// Subagents with a faux model: real child pi sessions, as the agent tool starts them, on pi-ai's
// faux provider, scripted response by response.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { ModCommand, ModEvent } from "@kndl/protocol"
import { Schema } from "effect"
import { childModel, childTools, createChild, Subagents } from "./Subagents.ts"

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

const faux = fauxProvider({ provider: "faux", models: [{ id: "small" }, { id: "large" }] })
let runtime: ModelRuntime
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kndl-subagents-"))
  runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
  runtime.registerNativeProvider(faux.provider)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A tool the child calls that waits until the test lets it go, or the run is stopped. */
const gate = () => {
  const reached = Promise.withResolvers<void>()
  const opened = Promise.withResolvers<void>()
  const tool: ToolDefinition = {
    name: "wait",
    label: "Wait",
    description: "Waits.",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      reached.resolve()
      await Promise.race([
        opened.promise,
        new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
      ])
      return { content: [{ type: "text", text: "waited" }], details: undefined }
    },
  }
  return { tool, reached: reached.promise, open: () => opened.resolve() }
}

const child = (tools: Array<ToolDefinition> = []) =>
  createChild({
    cwd: dir,
    agentDir: join(dir, "agent"),
    modelRuntime: runtime,
    model: faux.getModel("small") as never,
    thinkingLevel: "off",
    builtinTools: [],
    customTools: tools,
    settings: { retry: { enabled: false } },
  })

const tracker = () => {
  const events: Array<Record<string, unknown>> = []
  const notes: Array<string> = []
  let ids = 0
  const agents = new Subagents({
    report: (event) => events.push(event),
    now: () => 1_000,
    newId: () => `id${++ids}`,
    notify: (text) => notes.push(text),
  })
  return { agents, events, notes }
}

let current: Subagents | undefined
afterEach(() => current?.dispose())

/** Every event decodes as the protocol has it. */
const valid = (events: ReadonlyArray<unknown>) =>
  events.every((event) =>
    Schema.is(Schema.toType(ModEvent))(Schema.decodeUnknownSync(ModEvent)(event)),
  )

const command = (message: Record<string, unknown>) =>
  Schema.decodeUnknownSync(ModCommand)({ sessionId: "s1", ...message })

/** The events, with consecutive text pieces merged: the faux model streams in random pieces. */
const merged = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.reduce<Array<Record<string, unknown>>>((all, event) => {
    const last = all.at(-1)
    if (event._tag === "TextDelta" && last?._tag === "TextDelta")
      all[all.length - 1] = { ...last, text: `${String(last.text)}${String(event.text)}` }
    else all.push(event)
    return all
  }, [])

/** The text of the transcript a request carried. */
const said = (context: TranscriptContext) => JSON.stringify(context.messages)

const until = async (check: () => boolean) => {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("a subagent (ADR 0014)", () => {
  test("is reported started under the call, runs with its events tagged, and its final answer is the call's", async () => {
    const { agents, events } = tracker()
    current = agents
    const wait = gate()
    wait.open()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {}, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Found it in a.ts."),
    ])
    const result = await agents.run({
      turnId: "t1",
      toolCallId: "call-agent",
      description: "Find the bug",
      prompt: "Find the bug in a.ts",
      model: "faux/small",
      session: await child([wait.tool]),
    })
    expect(result).toEqual({ agentId: "id1", text: "Found it in a.ts.", stopped: false })
    expect(merged(events)).toEqual([
      {
        _tag: "AgentStarted",
        turnId: "t1",
        agentId: "id1",
        toolCallId: "call-agent",
        agentType: "general-purpose",
        description: "Find the bug",
        model: "faux/small",
        background: false,
      },
      { _tag: "AgentStatusChanged", agentId: "id1", status: "Running" },
      expect.objectContaining({
        _tag: "ToolCallStarted",
        turnId: "id2",
        agentId: "id1",
        toolCallId: "c1",
        tool: "wait",
      }),
      expect.objectContaining({
        _tag: "ToolCallEnded",
        turnId: "id2",
        agentId: "id1",
        toolCallId: "c1",
        outcome: "Succeeded",
        output: "waited",
      }),
      { _tag: "TextDelta", turnId: "id2", agentId: "id1", text: "Found it in a.ts." },
      expect.objectContaining({ _tag: "TurnEnded", turnId: "id2", agentId: "id1", reason: "stop" }),
      { _tag: "AgentStatusChanged", agentId: "id1", status: "Done" },
    ])
    expect(valid(events)).toBe(true)
  })

  test("a message to it while it runs is read at its next step, with the sender's name", async () => {
    const { agents, events } = tracker()
    current = agents
    const wait = gate()
    let asked = ""
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
      (context) => {
        asked = said(context)
        return fauxAssistantMessage("Checked b.ts too.")
      },
    ])
    const running = agents.run({
      turnId: "t1",
      toolCallId: "call-agent",
      description: "Look",
      prompt: "Look at a.ts",
      model: "faux/small",
      session: await child([wait.tool]),
    })
    await wait.reached
    await agents.message(
      command({
        _tag: "DeliverAgentMessage",
        agentId: "id1",
        text: "and b.ts",
        sender: ada,
      }) as never,
    )
    wait.open()
    expect((await running).text).toBe("Checked b.ts too.")
    expect(asked).toContain("[Ada Lovelace] and b.ts")
    expect(events.filter((event) => event._tag === "AgentCommandFailed")).toEqual([])
  })

  test("StopAgent stops it: Stopped, and the call says so", async () => {
    const { agents, events } = tracker()
    current = agents
    const wait = gate()
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })])
    const running = agents.run({
      turnId: "t1",
      toolCallId: "call-agent",
      description: "Look",
      prompt: "Look",
      model: "faux/small",
      session: await child([wait.tool]),
    })
    await wait.reached
    agents.stop(command({ _tag: "StopAgent", agentId: "id1" }) as never)
    const result = await running
    expect(result.stopped).toBe(true)
    expect(result.text).toStartWith("The agent was stopped before it finished.")
    expect(events.at(-2)).toMatchObject({ _tag: "TurnEnded", agentId: "id1", reason: "aborted" })
    expect(events.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Stopped" })
  })

  test("a stopped Turn stops the agent it waits for", async () => {
    const { agents, events } = tracker()
    current = agents
    const wait = gate()
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })])
    const turn = new AbortController()
    const running = agents.run({
      turnId: "t1",
      toolCallId: "call-agent",
      description: "Look",
      prompt: "Look",
      model: "faux/small",
      session: await child([wait.tool]),
      signal: turn.signal,
    })
    await wait.reached
    turn.abort()
    expect((await running).stopped).toBe(true)
    expect(events.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Stopped" })
  })

  test("once it has finished, a message resumes it: a new run, Done again, and the main loop is told", async () => {
    const { agents, events, notes } = tracker()
    current = agents
    let resumedWith = ""
    faux.setResponses([
      fauxAssistantMessage("First answer."),
      (context) => {
        resumedWith = said(context)
        return fauxAssistantMessage("Second answer.")
      },
    ])
    await agents.run({
      turnId: "t1",
      toolCallId: "call-agent",
      description: "Answer",
      prompt: "Answer",
      model: "faux/small",
      session: await child(),
    })
    const from = events.length
    await agents.message(
      command({ _tag: "DeliverAgentMessage", agentId: "id1", text: "again", sender: ada }) as never,
    )
    await until(() => events.at(-1)?.status === "Done" && events.length > from + 1)
    expect(resumedWith).toContain("First answer.")
    expect(resumedWith).toContain("[Ada Lovelace] again")
    const resumed = events.slice(from)
    expect(resumed[0]).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Running" })
    expect(resumed).toContainEqual(
      expect.objectContaining({ _tag: "TurnEnded", turnId: "id3", agentId: "id1" }),
    )
    expect(resumed.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Done" })
    expect(notes).toEqual([expect.stringContaining("Second answer.")])
    expect(notes[0]).toContain('id1 ("Answer")')
  })

  test("a message to an agent it doesn't know, or a stop of one that isn't running, fails, saying why", async () => {
    const { agents, events } = tracker()
    current = agents
    faux.setResponses([fauxAssistantMessage("Done.")])
    await agents.run({
      turnId: "t1",
      toolCallId: "call-agent",
      description: "Answer",
      prompt: "Answer",
      model: "faux/small",
      session: await child(),
    })
    const from = events.length
    await agents.message(
      command({ _tag: "DeliverAgentMessage", agentId: "nope", text: "hi", sender: ada }) as never,
    )
    agents.stop(command({ _tag: "StopAgent", agentId: "nope" }) as never)
    agents.stop(command({ _tag: "StopAgent", agentId: "id1" }) as never)
    expect(events.slice(from)).toEqual([
      {
        _tag: "AgentCommandFailed",
        agentId: "nope",
        command: "MessageAgent",
        senderId: "p1",
        message: "This Session has no agent nope.",
      },
      {
        _tag: "AgentCommandFailed",
        agentId: "nope",
        command: "StopAgent",
        message: "This Session has no agent nope.",
      },
      {
        _tag: "AgentCommandFailed",
        agentId: "id1",
        command: "StopAgent",
        message: "The agent isn't running.",
      },
    ])
    expect(valid(events)).toBe(true)
  })

  test("started outside a Turn, it runs unreported", async () => {
    const { agents, events } = tracker()
    current = agents
    faux.setResponses([fauxAssistantMessage("Quietly done.")])
    const result = await agents.run({
      turnId: undefined,
      toolCallId: "call-agent",
      description: "Answer",
      prompt: "Answer",
      model: "faux/small",
      session: await child(),
    })
    expect(result.text).toBe("Quietly done.")
    expect(events).toEqual([])
  })
})

/** Where a tool comes from, as pi says: `builtin` for its own. */
const source = (kind: string) => ({ path: "", source: kind, scope: "user", origin: "top-level" })

describe("what a subagent runs on", () => {
  const parent = { provider: "faux", id: "large" }
  const offered = ["faux/small", "faux/large"]

  test("the model asked for, as <provider>/<id>, or the parent's", () => {
    expect(childModel(runtime, "faux/small", parent, offered).id).toBe("small")
    expect(childModel(runtime, undefined, parent, offered).id).toBe("large")
    expect(childModel(runtime, " ", parent, offered).id).toBe("large")
  })

  test("a model there isn't fails the call, naming those there are", () => {
    expect(() => childModel(runtime, "faux/huge", parent, offered)).toThrow(
      "There is no model faux/huge. Use one of: faux/small, faux/large.",
    )
    expect(() => childModel(runtime, "huge", parent, offered)).toThrow("There is no model huge.")
    expect(() => childModel(runtime, undefined, undefined, [])).toThrow(
      "There is no model to run the agent on.",
    )
  })

  test("the parent's active tools, but the agent and question tools: pi's own by name, the rest as the parent runs them", async () => {
    const called: Array<unknown> = []
    const tool = (name: string) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async (...args: Array<unknown>) => {
        called.push(args)
        return { content: [{ type: "text" as const, text: name }], details: undefined }
      },
    })
    const tools = childTools(
      ["read", "bash", "attachment", "agent", "ask_user_question"],
      [
        { name: "read", sourceInfo: source("builtin") as never },
        { name: "bash", sourceInfo: source("builtin") as never },
        { name: "write", sourceInfo: source("builtin") as never },
        { name: "attachment", sourceInfo: source("local") as never },
        { name: "agent", sourceInfo: source("local") as never },
        { name: "ask_user_question", sourceInfo: source("local") as never },
        { name: "lookup", sourceInfo: source("local") as never },
      ],
      [tool("read"), tool("bash"), tool("attachment"), tool("lookup")] as never,
    )
    expect(tools.builtinTools).toEqual(["read", "bash"])
    expect(tools.customTools.map((each) => each.name)).toEqual(["attachment"])
    const result = await tools.customTools[0]?.execute("c1", {}, undefined, undefined, {} as never)
    expect(result?.content).toEqual([{ type: "text", text: "attachment" }])
    expect(called).toEqual([["c1", {}, undefined, undefined]])
  })
})
