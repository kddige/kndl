// Subagents with a faux model: real child pi sessions, as the agent tool starts them, kept in files
// under a directory of their own, on pi-ai's faux provider, scripted response by response.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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
import { sessionCwdFor } from "./claude/SessionCwd.ts"
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

let stores = 0

/**
 * Subagents kept in a directory of their own (or `agents`, another's, as after a restart), whose
 * children run on the faux model with `tools`; their ids and their runs' are `<ids>1`, `<ids>2`...
 */
const tracker = (
  options: { tools?: Array<ToolDefinition>; agents?: string; ids?: string } = {},
) => {
  const events: Array<Record<string, unknown>> = []
  const delivered: Array<{ agentId: string; text: string }> = []
  const notes: Array<string> = []
  const agentsDir = options.agents ?? join(dir, `agents-${++stores}`)
  let ids = 0
  const agents = new Subagents({
    report: (event) => events.push(event),
    now: () => 1_000,
    newId: () => `${options.ids ?? "id"}${++ids}`,
    dir: agentsDir,
    open: async (file, name) => {
      const model = faux.getModel(name?.replace("faux/", "") ?? "small")
      if (model === undefined) throw new Error(`There is no model ${name}.`)
      const session = await createChild({
        cwd: dir,
        agentDir: join(dir, "agent"),
        file,
        modelRuntime: runtime,
        model,
        thinkingLevel: "off",
        builtinTools: [],
        customTools: options.tools ?? [],
        settings: { retry: { enabled: false } },
      })
      return { session, model: `${model.provider}/${model.id}` }
    },
    deliver: (message) => delivered.push(message),
    note: (text) => notes.push(text),
  })
  current.push(agents)
  return { agents, events, delivered, notes, agentsDir }
}

const current: Array<Subagents> = []
afterEach(() => {
  for (const agents of current.splice(0)) agents.dispose()
})

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
    if (tries > 300) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const start = {
  turnId: "t1",
  toolCallId: "call-agent",
  description: "Find the bug",
  prompt: "Find the bug in a.ts",
  model: undefined,
}

describe("a subagent runs in the background (ADR 0014)", () => {
  test("starting it returns at once; it is reported started under the call, runs with its events tagged, and its result comes to the main loop as a message", async () => {
    const wait = gate()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {}, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Found it in a.ts."),
    ])
    const { agents, events: toolEvents, delivered: toolDelivered } = tracker({ tools: [wait.tool] })
    const started = await agents.start(start)
    expect(started).toEqual({ agentId: "id1" })
    await wait.reached
    // It runs on after the call returned; nothing is delivered until it ends.
    expect(toolDelivered).toEqual([])
    wait.open()
    await until(() => toolDelivered.length > 0)
    expect(merged(toolEvents)).toEqual([
      {
        _tag: "AgentStarted",
        turnId: "t1",
        agentId: "id1",
        toolCallId: "call-agent",
        agentType: "general-purpose",
        description: "Find the bug",
        model: "faux/small",
        background: true,
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
    expect(valid(toolEvents)).toBe(true)
    expect(toolDelivered).toEqual([
      {
        agentId: "id1",
        text: [
          "<task-notification>",
          "<task-id>id1</task-id>",
          "<status>completed</status>",
          '<summary>Agent "Find the bug" finished</summary>',
          "<note>Message it with message_agent to give it more to do; it keeps its context.</note>",
          "<result>Found it in a.ts.</result>",
          "</task-notification>",
        ].join("\n"),
      },
    ])
  })
})

describe("a call can wait for an agent", () => {
  test("with wait, the call gets its final answer, it is reported in the foreground, and nothing is delivered", async () => {
    const { agents, events, delivered } = tracker()
    faux.setResponses([fauxAssistantMessage("Found it in a.ts.")])
    const started = await agents.start({ ...start, model: "faux/large", wait: true })
    expect(started).toEqual({
      agentId: "id1",
      result: { agentId: "id1", outcome: "completed", text: "Found it in a.ts." },
    })
    expect(events[0]).toMatchObject({
      _tag: "AgentStarted",
      model: "faux/large",
      background: false,
    })
    expect(events.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Done" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(delivered).toEqual([])
  })

  test("a stopped Turn stops the agent it waits for", async () => {
    const wait = gate()
    const { agents, events, delivered } = tracker({ tools: [wait.tool] })
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })])
    const turn = new AbortController()
    const running = agents.start({ ...start, wait: true, signal: turn.signal })
    await wait.reached
    turn.abort()
    expect((await running).result?.outcome).toBe("stopped")
    expect(events.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Stopped" })
    expect(delivered).toEqual([])
  })

  test("a model it can't run on fails the call, and nothing is reported", async () => {
    const { agents, events } = tracker()
    await expect(agents.start({ ...start, model: "faux/huge" })).rejects.toThrow(
      "There is no model faux/huge.",
    )
    expect(events).toEqual([])
  })
})

describe("messaging and stopping an agent", () => {
  test("the Creator's message to a running agent is read at its next step, with their name", async () => {
    const wait = gate()
    const { agents, events, delivered } = tracker({ tools: [wait.tool] })
    let asked = ""
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
      (context) => {
        asked = said(context)
        return fauxAssistantMessage("Checked b.ts too.")
      },
    ])
    await agents.start(start)
    await wait.reached
    await agents.messageFromCreator(
      command({
        _tag: "DeliverAgentMessage",
        agentId: "id1",
        text: "and b.ts",
        sender: ada,
      }) as never,
    )
    wait.open()
    await until(() => delivered.length > 0)
    expect(asked).toContain("[Ada Lovelace] and b.ts")
    expect(delivered[0]?.text).toContain("<result>Checked b.ts too.</result>")
    expect(events.filter((event) => event._tag === "AgentCommandFailed")).toEqual([])
  })

  test("once it has finished, a message resumes it with its context: a new run, Done again, and its result is delivered", async () => {
    const { agents, events, delivered } = tracker()
    let resumedWith = ""
    faux.setResponses([
      fauxAssistantMessage("First answer."),
      (context) => {
        resumedWith = said(context)
        return fauxAssistantMessage("Second answer.")
      },
    ])
    await agents.start(start)
    await until(() => delivered.length === 1)
    const from = events.length
    expect(await agents.message("id1", "again")).toEqual({ steered: false })
    await until(() => delivered.length === 2)
    expect(resumedWith).toContain("Find the bug in a.ts")
    expect(resumedWith).toContain("First answer.")
    expect(resumedWith).toContain("again")
    const resumed = events.slice(from)
    expect(resumed[0]).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Running" })
    expect(resumed).toContainEqual(
      expect.objectContaining({ _tag: "TurnEnded", turnId: "id3", agentId: "id1" }),
    )
    expect(resumed.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Done" })
    expect(delivered[1]).toEqual({
      agentId: "id1",
      text: expect.stringContaining("<result>Second answer.</result>"),
    })
  })

  test("a message that waits gets the resumed run's answer, and nothing is delivered", async () => {
    const { agents, delivered } = tracker()
    faux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")])
    await agents.start({ ...start, wait: true })
    expect(await agents.message("id1", "again", { wait: true })).toEqual({
      steered: false,
      result: { agentId: "id1", outcome: "completed", text: "Second." },
    })
    expect(delivered).toEqual([])
  })

  test("the model's stop returns what it had said, Stopped, and delivers nothing", async () => {
    const wait = gate()
    const { agents, events, delivered } = tracker({ tools: [wait.tool] })
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })])
    await agents.start(start)
    await wait.reached
    const result = await agents.stop("id1")
    expect(result.outcome).toBe("stopped")
    expect(result.text).toStartWith("The agent was stopped before it finished.")
    expect(events.at(-2)).toMatchObject({ _tag: "TurnEnded", agentId: "id1", reason: "aborted" })
    expect(events.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Stopped" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(delivered).toEqual([])
    await expect(agents.stop("id1")).rejects.toThrow("The agent isn't running.")
  })

  test("the Creator's StopAgent stops it, and the main loop is told", async () => {
    const wait = gate()
    const { agents, events, delivered } = tracker({ tools: [wait.tool] })
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })])
    await agents.start(start)
    await wait.reached
    agents.stopFromCreator(command({ _tag: "StopAgent", agentId: "id1" }) as never)
    await until(() => delivered.length > 0)
    expect(events.at(-1)).toEqual({ _tag: "AgentStatusChanged", agentId: "id1", status: "Stopped" })
    expect(delivered[0]?.text).toContain("<status>stopped</status>")
    expect(delivered[0]?.text).toContain('<summary>Agent "Find the bug" was stopped</summary>')
  })

  test("a message to an agent it doesn't know, or a stop of one that isn't running, fails, saying why", async () => {
    const { agents, events, delivered } = tracker()
    faux.setResponses([fauxAssistantMessage("Done.")])
    await agents.start(start)
    await until(() => delivered.length > 0)
    const from = events.length
    await expect(agents.message("nope", "hi")).rejects.toThrow("This Session has no agent nope.")
    await agents.messageFromCreator(
      command({ _tag: "DeliverAgentMessage", agentId: "nope", text: "hi", sender: ada }) as never,
    )
    agents.stopFromCreator(command({ _tag: "StopAgent", agentId: "nope" }) as never)
    agents.stopFromCreator(command({ _tag: "StopAgent", agentId: "id1" }) as never)
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
    faux.setResponses([fauxAssistantMessage("Quietly done.")])
    const started = await agents.start({ ...start, turnId: undefined, wait: true })
    expect(started.result?.text).toBe("Quietly done.")
    expect(events).toEqual([])
  })
})

describe("agents outlive pi (they are kept on disk)", () => {
  test("each one's conversation is a file, beside an index of their description, model and status", async () => {
    const { agents, delivered, agentsDir } = tracker()
    faux.setResponses([fauxAssistantMessage("Remembered kiwi.")])
    await agents.start({ ...start, model: "faux/large" })
    await until(() => delivered.length > 0)
    expect(existsSync(join(agentsDir, "id1.jsonl"))).toBe(true)
    expect(JSON.parse(readFileSync(join(agentsDir, "index.json"), "utf8"))).toEqual({
      agents: [
        {
          agentId: "id1",
          description: "Find the bug",
          model: "faux/large",
          status: "Done",
          reported: true,
        },
      ],
    })
  })

  test("another pi on the same directory, such as one a tool runs, keeps the Session's agents in the index", async () => {
    const session = tracker()
    faux.setResponses([fauxAssistantMessage("Mine."), fauxAssistantMessage("Theirs.")])
    await session.agents.start({ ...start, wait: true })
    const other = tracker({ agents: session.agentsDir, ids: "other" })
    await other.agents.start({ ...start, description: "Other", wait: true })
    const index = JSON.parse(readFileSync(join(session.agentsDir, "index.json"), "utf8"))
    expect(index.agents.map((agent: { description: string }) => agent.description)).toEqual([
      "Find the bug",
      "Other",
    ])
  })

  test("after pi starts again, a message resumes a finished agent on its saved conversation and model", async () => {
    const first = tracker()
    faux.setResponses([fauxAssistantMessage("Remembered kiwi.")])
    await first.agents.start({ ...start, prompt: "Remember the word kiwi.", model: "faux/large" })
    await until(() => first.delivered.length > 0)
    first.agents.dispose()

    const second = tracker({ agents: first.agentsDir })
    second.agents.load()
    expect(second.notes).toEqual([])
    let resumedWith = ""
    let model = ""
    faux.setResponses([
      (context, _options, _state, asked) => {
        resumedWith = said(context)
        model = asked.id
        return fauxAssistantMessage("The word was kiwi.")
      },
    ])
    await second.agents.message("id1", "Which word?")
    await until(() => second.delivered.length > 0)
    expect(resumedWith).toContain("Remember the word kiwi.")
    expect(resumedWith).toContain("Remembered kiwi.")
    expect(resumedWith).toContain("Which word?")
    expect(model).toBe("large")
    expect(second.events[0]).toEqual({
      _tag: "AgentStatusChanged",
      agentId: "id1",
      status: "Running",
    })
    expect(second.delivered[0]?.text).toContain("<result>The word was kiwi.</result>")
  })

  test("one running when pi stops is Interrupted: said to the Hub then, and to the main loop when pi starts again, and a message resumes it", async () => {
    const wait = gate()
    const first = tracker({ tools: [wait.tool] })
    faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })])
    await first.agents.start(start)
    await wait.reached
    first.agents.dispose()
    expect(first.events.at(-1)).toEqual({
      _tag: "AgentStatusChanged",
      agentId: "id1",
      status: "Interrupted",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(first.delivered).toEqual([])
    expect(first.events.filter((event) => event._tag === "AgentStatusChanged")).toHaveLength(2)

    const second = tracker({ agents: first.agentsDir, tools: [wait.tool] })
    second.agents.load()
    expect(second.events).toEqual([])
    expect(second.notes).toEqual([
      [
        "<task-notification>",
        "<task-id>id1</task-id>",
        "<status>interrupted</status>",
        '<summary>Agent "Find the bug" was interrupted when this session stopped</summary>',
        "<note>Message it with message_agent to resume it where it left off; it keeps its context.</note>",
        "</task-notification>",
      ].join("\n"),
    ])
    expect(
      JSON.parse(readFileSync(join(first.agentsDir, "index.json"), "utf8")).agents[0],
    ).toMatchObject({ status: "Interrupted" })
    // Told once: a third start has nothing to say.
    second.agents.load()
    expect(second.notes).toHaveLength(1)

    faux.setResponses([fauxAssistantMessage("Carried on.")])
    await second.agents.message("id1", "go on")
    await until(() => second.delivered.length > 0)
    expect(second.delivered[0]?.text).toContain("<result>Carried on.</result>")
  })
})

/** Where a tool comes from, as pi says: `builtin` for its own. */
const source = (kind: string) => ({ path: "", source: kind, scope: "user", origin: "top-level" })

/** A tool as pi lists it. */
const info = (name: string, kind: string) => ({
  name,
  description: `${name}, as listed`,
  parameters: Type.Object({}),
  sourceInfo: source(kind) as never,
})

describe("what a subagent runs on", () => {
  test("a session the Claude bridge follows, new or resumed from its file, so its Claude turns find their directory and prompt", async () => {
    const file = join(dir, "followed.jsonl")
    const open = () =>
      createChild({
        cwd: dir,
        agentDir: join(dir, "agent"),
        file,
        modelRuntime: runtime,
        model: faux.getModel("small") as never,
        thinkingLevel: "off",
        builtinTools: [],
        customTools: [],
        settings: { retry: { enabled: false } },
      })
    const session = await open()
    expect(sessionCwdFor(session.sessionManager.getSessionId())).toBe(dir)
    faux.setResponses([fauxAssistantMessage("Hi.")])
    await session.prompt("hello")
    const id = session.sessionManager.getSessionId()
    session.dispose()
    const resumed = await open()
    expect(resumed.sessionManager.getSessionId()).toBe(id)
    expect(sessionCwdFor(id)).toBe(dir)
    resumed.dispose()
  })

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
  const listed = [
    info("read", "builtin"),
    info("bash", "builtin"),
    info("write", "builtin"),
    info("attachment", "local"),
    info("agent", "local"),
    info("message_agent", "local"),
    info("stop_agent", "local"),
    info("ask_user_question", "local"),
    info("lookup", "local"),
  ]
  const active = [
    "read",
    "bash",
    "attachment",
    "agent",
    "message_agent",
    "stop_agent",
    "ask_user_question",
  ]

  test("the parent's active tools, but the agent, message, stop and question tools: pi's own by name, the rest as the parent runs them", async () => {
    called.length = 0
    const tools = childTools(
      active,
      listed,
      () => [tool("read"), tool("bash"), tool("attachment"), tool("lookup")] as never,
    )
    expect(tools.builtinTools).toEqual(["read", "bash"])
    expect(tools.customTools.map((each) => [each.name, each.description])).toEqual([
      ["attachment", "attachment"],
    ])
    const result = await tools.customTools[0]?.execute("c1", {}, undefined, undefined, {} as never)
    expect(result?.content).toEqual([{ type: "text", text: "attachment" }])
    expect(called).toEqual([["c1", {}, undefined, undefined]])
  })

  test("before the parent has run a tool, its tools are as pi lists them, and found when called", async () => {
    called.length = 0
    const main: { tools?: Array<ReturnType<typeof tool>> } = {}
    const tools = childTools(active, listed, () => main.tools as never)
    expect(tools.customTools.map((each) => [each.name, each.description])).toEqual([
      ["attachment", "attachment, as listed"],
    ])
    const attachment = tools.customTools[0]
    expect(() => attachment?.execute("c1", {}, undefined, undefined, {} as never)).toThrow(
      "The tool attachment isn't available.",
    )
    main.tools = [tool("attachment")]
    const result = await attachment?.execute("c2", {}, undefined, undefined, {} as never)
    expect(result?.content).toEqual([{ type: "text", text: "attachment" }])
  })
})
