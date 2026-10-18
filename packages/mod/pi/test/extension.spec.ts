// kndl's pi extension end to end: the real pi (`--mode rpc`) loads the built extension, links to
// a fake Hub, and runs its models through the fake Hub's Gateway. Skipped when pi can't run here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { errorReply, FakeHub, hangingReply, textReply, toolCallReply, when } from "./FakeHub.ts"
import type { Script } from "./FakeHub.ts"

const root = join(import.meta.dir, "../..")
const extension = join(root, "pi/dist/kndl.js")
const piCli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")

/** Why pi can't run here, if it can't: it needs Node 22.19 or newer. */
const cannotRun = (() => {
  if (!existsSync(piCli)) return "pi isn't installed"
  const node = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "ignore" })
  if (node.exitCode !== 0) return "there is no node"
  const [major = 0, minor = 0] = node.stdout.toString().trim().slice(1).split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 19)) return `node ${major}.${minor} is too old for pi`
  return undefined
})()
if (cannotRun !== undefined)
  console.warn(`skipping the pi extension's end-to-end test: ${cannotRun}`)

const modToken = "tok-e2e$1"
const sessionId = "s-e2e"
const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }
/** A 1x1 PNG. */
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

/** pi in RPC mode, as a Runner would start it, with what it said. */
interface Pi {
  readonly process: Subprocess<"pipe", "pipe", "pipe">
  readonly stderr: () => string
  /** The dialogs pi asked its RPC client for, which stand for its terminal's. */
  readonly dialogs: Array<Record<string, unknown>>
}

/** Starts pi with the built extension, in `home`, linked to `hub`, with `args`. */
const startPi = (
  home: string,
  hub: FakeHub,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Pi => {
  const process = Bun.spawn(["node", piCli, "--mode", "rpc", "-e", extension, ...args], {
    cwd: home,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, "agent"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      KNDL_URL: hub.url,
      KNDL_MOD_TOKEN: modToken,
      KNDL_SESSION_ID: sessionId,
      ...env,
    },
  })
  let stderr = ""
  void (async () => {
    for await (const chunk of process.stderr) stderr += new TextDecoder().decode(chunk)
  })()
  // pi's RPC records go to stdout; read them so pi never stalls on a full pipe, and keep the
  // dialogs it asks its client for.
  const dialogs: Array<Record<string, unknown>> = []
  void (async () => {
    let buffered = ""
    for await (const chunk of process.stdout) {
      buffered += new TextDecoder().decode(chunk)
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (record.type === "extension_ui_request" && record.method !== "setWidget")
            dialogs.push(record)
        } catch {
          // Not a record.
        }
      }
    }
  })()
  return { process, stderr: () => stderr, dialogs }
}

/** The bundle pi loads, from the sources as they are now. */
const build = () => {
  const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: root, stdout: "ignore" })
  if (built.exitCode !== 0 || !existsSync(extension))
    throw new Error("couldn't build the pi extension")
}

/** What a subagent's requests say, in its system prompt, and its parent's don't. */
const childNote = "You are an agent that another agent started"
/** `script`, for a subagent's request. */
const ofChild = (script: Script) => when(script, childNote)
/** `script`, for the main loop's request. */
const ofParent = (script: Script) => when(script, childNote, true)

type HubEvent = FakeHub["events"][number]

/**
 * The events after the `from`th, up to the end of the first Turn an agent's result started
 * (ADR 0014): a TurnStarted from the agent, and its TurnEnded.
 */
const untilResultTurnEnds = (hub: FakeHub, from: number) =>
  hub.eventsUntil(from, (event) => {
    if (event._tag !== "TurnEnded" || event.agentId !== undefined) return false
    const started = hub.events.find(
      (each, at) => at >= from && each._tag === "TurnStarted" && each.turnId === event.turnId,
    )
    return (started?.sender as { _tag?: string } | undefined)?._tag === "FromAgent"
  })

/** The Turn an agent's result started, among `events`: its TurnStarted. */
const resultTurn = (events: ReadonlyArray<HubEvent>) =>
  events.find(
    (event) =>
      event._tag === "TurnStarted" && (event.sender as { _tag?: string })._tag === "FromAgent",
  )

describe.skipIf(cannotRun !== undefined)("kndl's pi extension, in pi", () => {
  let hub: FakeHub
  let pi: Subprocess<"pipe", "pipe", "pipe">
  let running: Pi
  let home: string
  /** The dialogs pi asked its RPC client for. */
  let dialogs: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    build()
    hub = new FakeHub({
      modToken,
      providers: {
        models: [
          { provider: "openai", id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] },
          {
            provider: "xai",
            id: "grok-4.3",
            label: "Grok 4.3",
            thinkingLevels: ["off", "low", "medium", "high"],
          },
        ],
      } as never,
      attachments: {
        "att-1": { id: "att-1", name: "shot.png", mediaType: "image/png", data: png },
      },
    })
    home = mkdtempSync(join(tmpdir(), "kndl-pi-e2e-"))
    // The Workspace is a Repo with a Claude Code skill.
    mkdirSync(join(home, ".claude", "skills", "greet"), { recursive: true })
    writeFileSync(
      join(home, ".claude", "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets the e2e person by name.\n---\n\nSay hello.\n",
    )
    running = startPi(
      home,
      hub,
      // With a Repo extension of its own, loaded after kndl's, which handles some prompts itself.
      [
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--model",
        "openai/gpt-4.1",
        "-e",
        join(import.meta.dir, "fixtures", "swallow.js"),
      ],
      { KNDL_MCP_SERVERS: JSON.stringify([{ installationId: "inst-1", server: "linear" }]) },
    )
    pi = running.process
    dialogs = running.dialogs
  })

  afterAll(async () => {
    pi?.kill()
    hub?.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  const debug = () => {
    const log = join(home, "agent", "kndl.log")
    return `stderr: ${running.stderr()}\nkndl.log: ${existsSync(log) ? readFileSync(log, "utf8") : "(none)"}`
  }

  test("says hello once pi's session is known: its conversation, its model, and that it steers, attaches, switches models and takes handoffs", async () => {
    const hello = await hub
      .until(() => hub.hellos[0])
      .catch((error) => {
        throw new Error(`${error}\n${debug()}`)
      })
    expect(hello).toMatchObject({
      _tag: "ModHello",
      sessionId,
      model: "openai/gpt-4.1",
      steers: true,
      attaches: true,
      switchesModels: true,
      takesHandoffs: true,
    })
    expect(String(hello.conversationId)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  }, 30_000)

  test("a delivered prompt is a Turn: from its sender, through the Gateway with the Session token, opening its file, to its end with the usage summed", async () => {
    hub.scripts.push(
      toolCallReply("attachment", { id: "att-1" }, { input: 300, output: 10 }),
      textReply("A red dot.", { input: 400, output: 5, cached: 300 }),
    )
    const from = hub.events.length
    hub.send({
      _tag: "DeliverPrompt",
      sessionId,
      promptId: "q1",
      text: "what is this?",
      sender: ada,
      attachments: [{ id: "att-1", name: "shot.png", mediaType: "image/png", size: 70 }],
    })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    const turnId = events[0]?.turnId
    expect(events).toEqual([
      {
        _tag: "TurnStarted",
        turnId,
        text: "[Ada Lovelace] what is this?\n[Image #1: shot.png (attachment att-1)]",
        sender: { _tag: "FromParticipant", participant: ada },
        promptId: "q1",
      },
      expect.objectContaining({
        _tag: "ToolCallStarted",
        turnId,
        tool: "attachment",
        input: '{"id":"att-1"}',
      }),
      expect.objectContaining({
        _tag: "ToolCallEnded",
        turnId,
        tool: "attachment",
        outcome: "Succeeded",
        output: "shot.png\n[image/png]",
      }),
      { _tag: "TextDelta", turnId, text: "A red dot." },
      {
        _tag: "TurnEnded",
        turnId,
        reason: "stop",
        durationMs: expect.any(Number),
        usage: {
          model: "openai/gpt-4.1",
          input: 700,
          output: 15,
          cacheRead: 300,
          cacheWrite: 0,
          cost: expect.any(Number),
        },
      },
    ])
    const [first, second] = hub.gatewayRequests
    expect(first?.path).toBe("/gateway/models/openai/v1/responses")
    expect(first?.authorization).toBe(`Bearer ${modToken}`)
    expect(first?.body.model).toBe("gpt-4.1")
    const asked = JSON.stringify(first?.body)
    expect(asked).toContain("This session is shared through kndl")
    expect(asked).toContain("by calling attachment once per file with its id")
    // The image itself reached the model, in the tool's result.
    expect(JSON.stringify(second?.body)).toContain(png.slice(0, 40))
  }, 30_000)

  test("a prompt delivered again isn't run twice (#323)", async () => {
    const from = hub.events.length
    hub.send({
      _tag: "DeliverPrompt",
      sessionId,
      promptId: "q1",
      text: "what is this?",
      sender: ada,
    })
    const events = await hub.eventsUntil(from, (event) => event._tag === "PromptAlreadySubmitted")
    expect(events).toEqual([{ _tag: "PromptAlreadySubmitted", promptId: "q1" }])
  })

  test("a prompt pi doesn't run, as one another extension handles, is said to have failed, and can be delivered again (#323)", async () => {
    const swallowed = {
      _tag: "DeliverPrompt",
      sessionId,
      promptId: "q-swallowed",
      text: "[swallow] this",
      sender: ada,
    }
    for (let delivery = 1; delivery <= 2; delivery++) {
      const from = hub.events.length
      hub.send(swallowed)
      const events = await hub.eventsUntil(from, (event) => event._tag === "PromptFailed")
      expect(events).toEqual([
        { _tag: "PromptFailed", promptId: "q-swallowed", message: "pi didn't run it" },
      ])
    }
  }, 30_000)

  test("the Repo's Claude Code skills load, and the model reaches the Session's MCP servers at the Gateway, with the Session token (ADR 0020, ADR 0029)", async () => {
    // pi connects to it as the session starts.
    await hub.until(() => hub.mcpRequests.find((request) => request.method === "tools/list"))
    expect(hub.mcpRequests[0]).toMatchObject({
      installationId: "inst-1",
      authorization: `Bearer ${modToken}`,
      method: "initialize",
    })
    expect(JSON.stringify(hub.gatewayRequests[0]?.body)).toContain("Greets the e2e person by name.")
    hub.scripts.push(
      toolCallReply(
        "codemode",
        { code: 'const r = await tools.mcp__kndl_linear__echo({ text: "hi" })\nreturn r.content' },
        { input: 10, output: 2 },
      ),
      textReply("It said hi.", { input: 20, output: 2 }),
    )
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q11", text: "echo", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: "ToolCallEnded",
        tool: "codemode",
        outcome: "Succeeded",
        output: expect.stringContaining("echo: hi"),
      }),
    )
    expect(hub.mcpRequests.find((request) => request.method === "tools/call")).toMatchObject({
      installationId: "inst-1",
      authorization: `Bearer ${modToken}`,
      params: { name: "echo", arguments: { text: "hi" } },
    })
  }, 30_000)

  test("a Turn the Provider refuses ends in an error that says why, without the Session token", async () => {
    hub.scripts.push(errorReply(400, `Incorrect API key provided: ${modToken}. Check it.`))
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q12", text: "fail", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    const ended = events.at(-1)
    expect(ended).toMatchObject({ _tag: "TurnEnded", reason: "error" })
    expect(String(ended?.errorMessage)).toContain(
      "Incorrect API key provided: [redacted]. Check it.",
    )
    expect(String(ended?.errorMessage)).not.toContain(modToken)
  }, 30_000)

  test("SwitchModel runs the next Turns on another Provider's model, at its thinking level", async () => {
    hub.send({ _tag: "SwitchModel", sessionId, model: "xai/grok-4.3", thinkingLevel: "low" })
    hub.scripts.push(textReply("Hi from Grok.", { input: 50, output: 4 }))
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q2", text: "hello", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events.at(-1)).toMatchObject({
      _tag: "TurnEnded",
      reason: "stop",
      usage: { model: "xai/grok-4.3", input: 50, output: 4 },
    })
    const request = hub.gatewayRequests[requests]
    expect(request?.path).toBe("/gateway/models/xai/v1/responses")
    expect(request?.body.model).toBe("grok-4.3")
    expect(request?.body.reasoning).toMatchObject({ effort: "low" })
  }, 30_000)

  test("SwitchModel to a Provider connected since pi started asks the Hub again, and switches", async () => {
    hub.providers = {
      models: [
        ...hub.providers.models,
        { provider: "meta", id: "muse-spark-1.3", label: "Muse Spark 1.3", thinkingLevels: [] },
      ],
    } as never
    hub.send({ _tag: "SwitchModel", sessionId, model: "meta/muse-spark-1.3" })
    hub.scripts.push(textReply("Hi from Muse.", { input: 30, output: 4 }))
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q13", text: "hello", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "ModelSwitchFailed")).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ usage: { model: "meta/muse-spark-1.3" } })
    expect(hub.gatewayRequests[requests]?.path).toBe("/gateway/models/meta/v1/responses")
    // The agent tool offers the model what it may run an agent on: the Models as listed now.
    const tools = hub.gatewayRequests[requests]?.body.tools as Array<{ name?: string }> | undefined
    const agentTool = tools?.find((tool) => tool.name === "agent")
    expect(JSON.stringify(agentTool)).toContain("meta/muse-spark-1.3")
  }, 30_000)

  test("a SwitchModel it can't make is said, and the Session keeps its model", async () => {
    // pi has OpenAI's GPT-4o built in, but the Creator's Models don't have it.
    for (const asked of ["openai/gpt-4o", "mistral/not-a-model"]) {
      const from = hub.events.length
      hub.send({ _tag: "SwitchModel", sessionId, model: asked })
      const events = await hub.eventsUntil(from, (event) => event._tag === "ModelSwitchFailed")
      expect(events.at(-1)).toEqual({
        _tag: "ModelSwitchFailed",
        asked,
        model: "meta/muse-spark-1.3",
        message:
          "it isn't one of the Creator's Models: its Provider isn't connected, or doesn't offer it",
      })
    }
    // Back on the first, for the tests after.
    const from = hub.events.length
    hub.send({ _tag: "SwitchModel", sessionId, model: "openai/gpt-4.1" })
    hub.scripts.push(textReply("Back.", { input: 5, output: 1 }))
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q14", text: "back?", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events.at(-1)).toMatchObject({ usage: { model: "openai/gpt-4.1" } })
  }, 30_000)

  test("a prompt steered into the running Turn joins it, and is read at its next request (ADR 0018)", async () => {
    hub.scripts.push(
      toolCallReply("bash", { command: "sleep 2" }, { input: 10, output: 2 }),
      textReply("Noted.", { input: 20, output: 2 }),
    )
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q3", text: "wait", sender: ada })
    await hub.eventsUntil(from, (event) => event._tag === "ToolCallStarted")
    hub.send({ _tag: "DeliverIntoTurn", sessionId, promptId: "q4", text: "and then?", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    const turnId = events[0]?.turnId
    const tags = events.map((event) => event._tag)
    expect(events).toContainEqual({
      _tag: "PromptSteered",
      turnId,
      promptId: "q4",
      text: "and then?",
      sender: ada,
    })
    expect(events).toContainEqual({ _tag: "SteeredPromptRead", turnId, promptId: "q4" })
    expect(tags.indexOf("PromptSteered")).toBeLessThan(tags.indexOf("SteeredPromptRead"))
    expect(tags.indexOf("SteeredPromptRead")).toBeLessThan(tags.indexOf("TextDelta"))
    expect(JSON.stringify(hub.gatewayRequests[requests + 1]?.body)).toContain(
      "Ada Lovelace sent a new message while you were working",
    )
  }, 30_000)

  test("a prompt can't be steered with no Turn running", async () => {
    const from = hub.events.length
    hub.send({ _tag: "DeliverIntoTurn", sessionId, promptId: "q5", text: "late", sender: ada })
    const events = await hub.eventsUntil(from, (event) => event._tag === "PromptFailed")
    expect(events).toEqual([
      { _tag: "PromptFailed", promptId: "q5", message: "no Turn is running" },
    ])
  })

  test("StopTurn stops the running Turn", async () => {
    hub.scripts.push(hangingReply("Thinking about it"))
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q6", text: "go on", sender: ada })
    await hub.eventsUntil(from, (event) => event._tag === "TextDelta")
    hub.send({ _tag: "StopTurn", sessionId })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "aborted" })
  }, 30_000)

  test("the model's question is the Session's Open question: the Creator's answer closes it, and the model reads it (#193)", async () => {
    const asked = [
      {
        question: "Which date library?",
        header: "Library",
        options: [{ label: "date-fns", description: "Small" }, { label: "Luxon" }],
        multiSelect: false,
      },
    ]
    hub.scripts.push(
      toolCallReply("ask_user_question", { questions: asked }, { input: 10, output: 2 }),
      textReply("Going with date-fns.", { input: 20, output: 4 }),
    )
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q8", text: "pick one", sender: ada })
    const [question] = (
      await hub.eventsUntil(from, (event) => event._tag === "QuestionAsked")
    ).slice(-1)
    const toolCallId = question?.toolCallId
    expect(question).toEqual({
      _tag: "QuestionAsked",
      turnId: expect.any(String),
      toolCallId: expect.any(String),
      questions: asked,
    })
    hub.send({
      _tag: "DeliverAnswer",
      sessionId,
      toolCallId,
      answer: { _tag: "Answered", answers: { "Which date library?": "date-fns" } },
      sender: ada,
    })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    const turnId = events[0]?.turnId
    expect(question?.turnId).toBe(turnId)
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "ToolCallStarted", toolCallId, tool: "ask_user_question" }),
    )
    expect(events).toContainEqual({
      _tag: "QuestionClosed",
      turnId,
      toolCallId,
      outcome: { _tag: "Answered", answers: { "Which date library?": "date-fns" } },
      by: ada,
    })
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "ToolCallEnded", toolCallId, outcome: "Succeeded" }),
    )
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", turnId, reason: "stop" })
    expect(JSON.stringify(hub.gatewayRequests[requests + 1]?.body)).toContain(
      'Ada Lovelace answered your questions:\\n- \\"Which date library?\\": date-fns',
    )
    // Answered already: another answer comes too late.
    const late = hub.events.length
    hub.send({
      _tag: "DeliverAnswer",
      sessionId,
      toolCallId,
      answer: { _tag: "Dismissed" },
      sender: ada,
    })
    expect(await hub.eventsUntil(late, (event) => event._tag === "AnswerFailed")).toEqual([
      {
        _tag: "AnswerFailed",
        toolCallId,
        senderId: ada.id,
        message: "The question was answered or closed already.",
      },
    ])
  }, 30_000)

  test("a question answered at pi's own terminal first closes with no one named", async () => {
    const asked = [
      {
        question: "Ship it?",
        header: "Ship",
        options: [{ label: "Yes" }, { label: "No" }],
        multiSelect: false,
      },
    ]
    hub.scripts.push(
      toolCallReply("ask_user_question", { questions: asked }, { input: 10, output: 2 }),
      textReply("Shipping.", { input: 20, output: 2 }),
    )
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    const shown = dialogs.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q10", text: "ship?", sender: ada })
    const dialog = await hub.until(() =>
      dialogs.slice(shown).find((each) => each.method === "select"),
    )
    expect(dialog).toMatchObject({
      title: "Ship: Ship it?",
      options: ["Yes", "No", "Type an answer…"],
    })
    pi.stdin.write(
      `${JSON.stringify({ type: "extension_ui_response", id: dialog.id, value: "Yes" })}\n`,
    )
    pi.stdin.flush()
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events).toContainEqual({
      _tag: "QuestionClosed",
      turnId: events[0]?.turnId,
      toolCallId: expect.any(String),
      outcome: { _tag: "Answered", answers: { "Ship it?": "Yes" } },
    })
    expect(JSON.stringify(hub.gatewayRequests[requests + 1]?.body)).toContain(
      "The person at the terminal answered your questions",
    )
  }, 30_000)

  /** The agent the tests below start, and then resume. */
  let agentId = ""

  test("the agent tool starts a subagent in the background: the call returns at once, the Turn ends while it runs, and its result starts a Turn from it (ADR 0014)", async () => {
    hub.scripts.push(
      ofParent(
        toolCallReply(
          "agent",
          { description: "Count files", prompt: "Count the files here.", model: "openai/gpt-4.1" },
          { input: 10, output: 2 },
        ),
      ),
      ofParent(textReply("It's counting.", { input: 20, output: 3 })),
      ofChild(toolCallReply("bash", { command: "sleep 1" }, { input: 30, output: 2 })),
      ofChild(textReply("There are 3 files.", { input: 30, output: 5 })),
    )
    // The main loop's request for the agent's result, once it has it.
    hub.scripts.push(
      when(textReply("The agent counted 3.", { input: 40, output: 5 }), "There are 3 files."),
    )
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q9", text: "count", sender: ada })
    const events = await untilResultTurnEnds(hub, from)
    const turnId = events[0]?.turnId
    const started = events.find((event) => event._tag === "AgentStarted")
    agentId = String(started?.agentId)
    const call = events.find((event) => event._tag === "ToolCallStarted" && event.tool === "agent")
    expect(started).toEqual({
      _tag: "AgentStarted",
      turnId,
      agentId: expect.any(String),
      toolCallId: call?.toolCallId,
      agentType: "general-purpose",
      description: "Count files",
      model: "openai/gpt-4.1",
      background: true,
    })
    // The call returned at once, saying the result comes later.
    const returned = events.find(
      (event) => event._tag === "ToolCallEnded" && event.tool === "agent",
    )
    expect(returned).toMatchObject({ turnId, outcome: "Succeeded" })
    expect(String(returned?.output)).toContain(`Started the agent ${agentId} in the background.`)
    // The Turn ended while the agent ran; its end started a Turn from it.
    const at = (check: (event: HubEvent) => boolean) => events.findIndex(check)
    const turnEnded = at((event) => event._tag === "TurnEnded" && event.turnId === turnId)
    const done = at((event) => event._tag === "AgentStatusChanged" && event.status === "Done")
    const result = resultTurn(events)
    expect(turnEnded).toBeGreaterThan(-1)
    expect(turnEnded).toBeLessThan(done)
    expect(done).toBeLessThan(events.indexOf(result as HubEvent))
    expect(result).toEqual({
      _tag: "TurnStarted",
      turnId: expect.any(String),
      text: expect.stringContaining("<result>There are 3 files.</result>"),
      sender: { _tag: "FromAgent", agentId },
    })
    expect(String(result?.text)).toStartWith("<task-notification>")
    expect(events.at(-1)).toMatchObject({
      _tag: "TurnEnded",
      turnId: result?.turnId,
      reason: "stop",
    })
    expect(events).toContainEqual({
      _tag: "TextDelta",
      turnId: result?.turnId,
      text: "The agent counted 3.",
    })
    // Its own run: events tagged with its id, its usage on its own TurnEnded.
    const agents = events.filter((event) => event.agentId === agentId)
    expect(agents.map((event) => event._tag)).toEqual([
      "AgentStarted",
      "AgentStatusChanged",
      "ToolCallStarted",
      "ToolCallEnded",
      "TextDelta",
      "TurnEnded",
      "AgentStatusChanged",
    ])
    expect(agents.find((event) => event._tag === "TurnEnded")).toMatchObject({
      reason: "stop",
      usage: { model: "openai/gpt-4.1", input: 60, output: 7 },
    })
    // Its requests went through the Gateway, with the Session token, knowing only its task.
    const child = hub.gatewayRequests
      .slice(requests)
      .find((request) => JSON.stringify(request.body).includes(childNote))
    expect(child?.path).toBe("/gateway/models/openai/v1/responses")
    expect(child?.authorization).toBe(`Bearer ${modToken}`)
    const asked = JSON.stringify(child?.body)
    expect(asked).toContain("Count the files here.")
    expect(asked).not.toContain("[Ada Lovelace] count")
    // The parent's tools, but the agent, message, stop and question tools.
    expect(asked).toContain('"name":"bash"')
    expect(asked).toContain('"name":"attachment"')
    for (const tool of ["agent", "message_agent", "stop_agent", "ask_user_question"])
      expect(asked).not.toContain(`"name":"${tool}"`)
  }, 30_000)

  test("the model's message resumes a finished agent with its context, and its result starts a Turn again", async () => {
    hub.scripts.push(
      ofParent(
        toolCallReply(
          "message_agent",
          { agentId, message: "Count them again." },
          { input: 10, output: 2 },
        ),
      ),
      ofParent(textReply("Asked it.", { input: 20, output: 2 })),
      ofChild(textReply("Now 4 files.", { input: 50, output: 5 })),
      when(textReply("It says 4.", { input: 40, output: 5 }), "Now 4 files."),
    )
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q15", text: "again", sender: ada })
    const events = await untilResultTurnEnds(hub, from)
    const returned = events.find(
      (event) => event._tag === "ToolCallEnded" && event.tool === "message_agent",
    )
    expect(String(returned?.output)).toContain(`Resumed the agent ${agentId}`)
    expect(events.filter((event) => event._tag === "AgentStatusChanged")).toEqual([
      { _tag: "AgentStatusChanged", agentId, status: "Running" },
      { _tag: "AgentStatusChanged", agentId, status: "Done" },
    ])
    expect(resultTurn(events)).toMatchObject({
      text: expect.stringContaining("<result>Now 4 files.</result>"),
      sender: { _tag: "FromAgent", agentId },
    })
    // It went on from its own conversation: its task and first answer, and the message.
    const child = hub.gatewayRequests
      .slice(requests)
      .find((request) => JSON.stringify(request.body).includes(childNote))
    const asked = JSON.stringify(child?.body)
    expect(asked).toContain("Count the files here.")
    expect(asked).toContain("There are 3 files.")
    expect(asked).toContain("Count them again.")
  }, 30_000)

  test("the Creator's message resumes it too, and its result starts a Turn; stopping it once it is done fails", async () => {
    hub.scripts.push(
      ofChild(textReply("Now 5 files.", { input: 50, output: 5 })),
      when(textReply("It says 5.", { input: 40, output: 5 }), "Now 5 files."),
    )
    const from = hub.events.length
    hub.send({ _tag: "DeliverAgentMessage", sessionId, agentId, text: "count again", sender: ada })
    const events = await untilResultTurnEnds(hub, from)
    expect(events[0]).toEqual({ _tag: "AgentStatusChanged", agentId, status: "Running" })
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "TextDelta", agentId, text: "Now 5 files." }),
    )
    expect(resultTurn(events)).toMatchObject({ sender: { _tag: "FromAgent", agentId } })
    expect(
      JSON.stringify(
        hub.gatewayRequests.findLast((request) => JSON.stringify(request.body).includes(childNote))
          ?.body,
      ),
    ).toContain("[Ada Lovelace] count again")
    const stopped = hub.events.length
    hub.send({ _tag: "StopAgent", sessionId, agentId })
    expect(await hub.eventsUntil(stopped, (event) => event._tag === "AgentCommandFailed")).toEqual([
      {
        _tag: "AgentCommandFailed",
        agentId,
        command: "StopAgent",
        message: "The agent isn't running.",
      },
    ])
  }, 30_000)

  test("a command for an agent the Session doesn't have fails, saying why", async () => {
    const from = hub.events.length
    hub.send({ _tag: "StopAgent", sessionId, agentId: "a1" })
    const events = await hub.eventsUntil(from, (event) => event._tag === "AgentCommandFailed")
    expect(events.at(-1)).toEqual({
      _tag: "AgentCommandFailed",
      agentId: "a1",
      command: "StopAgent",
      message: "This Session has no agent a1.",
    })
  })

  test("a prompt typed at the terminal is a Turn from the terminal, and one from the Hub meanwhile waits for it", async () => {
    hub.scripts.push(
      toolCallReply("bash", { command: "sleep 1" }, { input: 10, output: 2 }),
      textReply("Done here.", { input: 10, output: 2 }),
      textReply("Now yours.", { input: 10, output: 2 }),
    )
    const from = hub.events.length
    pi.stdin.write(`${JSON.stringify({ type: "prompt", message: "typed here" })}\n`)
    pi.stdin.flush()
    await hub.eventsUntil(from, (event) => event._tag === "ToolCallStarted")
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q7", text: "mine", sender: ada })
    const events = await hub.eventsUntil(
      from,
      (event) => event._tag === "TurnEnded" && event.turnId !== hub.events[from]?.turnId,
    )
    expect(events.filter((event) => event._tag === "TurnStarted")).toEqual([
      {
        _tag: "TurnStarted",
        turnId: expect.any(String),
        text: "typed here",
        sender: { _tag: "FromTerminal" },
      },
      expect.objectContaining({ promptId: "q7", text: "[Ada Lovelace] mine" }),
    ])
    const tags = events.map((event) => event._tag)
    expect(tags.indexOf("TurnEnded")).toBeLessThan(tags.lastIndexOf("TurnStarted"))
  }, 30_000)

  test("a context handoff reaches the model with the next prompt, ahead of it, and starts no Turn of its own (ADR 0030)", async () => {
    hub.scripts.push(textReply("Picking up from there.", { input: 10, output: 3 }))
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    const handoff =
      "Turn #12, prompted by Ada Lovelace\nPrompt: Add a health check.\nAnswer: Added GET /health."
    hub.send({
      _tag: "DeliverHandoff",
      sessionId,
      from: "ClaudeCode",
      text: handoff,
      earlierBefore: 12,
    })
    hub.send({
      _tag: "DeliverPrompt",
      sessionId,
      promptId: "q-handoff",
      text: "test it",
      sender: ada,
    })

    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(events[0]).toMatchObject({
      _tag: "TurnStarted",
      text: "[Ada Lovelace] test it",
      promptId: "q-handoff",
    })
    expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
    expect(hub.gatewayRequests).toHaveLength(requests + 1)
    const body = JSON.stringify(hub.gatewayRequests[requests]?.body)
    const note = body.indexOf("<context-handoff>")
    expect(note).toBeGreaterThan(-1)
    expect(body).toContain("Added GET /health.")
    expect(body).toContain("call session_history with before=12")
    expect(body.indexOf("[Ada Lovelace] test it")).toBeGreaterThan(note)
  })

  test("the history tool reads the Session's earlier Turns from the Hub (ADR 0030)", async () => {
    hub.history["before=12&limit=2"] = {
      turns: [
        {
          seq: 10,
          by: "Ada Lovelace",
          prompt: "Add a server.",
          tools: ["write: src/server.ts"],
          answer: "Added the server on port 8080.",
          model: "claude-opus-4-6",
        },
        { seq: 11, by: "terminal", prompt: "run it", tools: [], answer: "It's up." },
      ],
      earlierBefore: 10,
    }
    hub.scripts.push(
      toolCallReply("session_history", { before: 12, limit: 2 }, { input: 10, output: 2 }),
      textReply("Port 8080.", { input: 20, output: 2 }),
    )
    const requests = hub.gatewayRequests.length
    const from = hub.events.length
    hub.send({
      _tag: "DeliverPrompt",
      sessionId,
      promptId: "q-history",
      text: "which port?",
      sender: ada,
    })

    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded")
    expect(hub.historyRequests).toEqual(["before=12&limit=2"])
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: "ToolCallEnded",
        tool: "session_history",
        outcome: "Succeeded",
      }),
    )
    const body = JSON.stringify(hub.gatewayRequests[requests + 1]?.body)
    expect(body).toContain("Turn #10, prompted by Ada Lovelace, on claude-opus-4-6")
    expect(body).toContain("Added the server on port 8080.")
    expect(body).toContain("call session_history with before=10")
  })

  test("leaves pi when its session ends", async () => {
    pi.stdin.end()
    const exited = await Promise.race([
      pi.exited,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000)),
    ])
    expect(exited).not.toBe("hung")
  }, 20_000)
})

/** Ends pi as a sleep does, and waits for it to exit. */
const stopPi = async (pi: Pi) => {
  pi.process.stdin.end()
  const exited = await Promise.race([
    pi.process.exited,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000)),
  ])
  if (exited === "hung") pi.process.kill()
}

describe.skipIf(cannotRun !== undefined)("a pi Session's agents outlive pi", () => {
  let hub: FakeHub
  let home: string
  let pi: Pi | undefined
  const conversation = "c0ffee00-0000-4000-8000-000000000001"
  const start = () =>
    startPi(home, hub, [
      "--session-id",
      conversation,
      "--no-skills",
      "--no-context-files",
      "--model",
      "openai/gpt-4.1",
    ])

  beforeAll(() => {
    build()
    hub = new FakeHub({
      modToken,
      providers: {
        models: [{ provider: "openai", id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] }],
      } as never,
      attachments: {},
    })
    home = mkdtempSync(join(tmpdir(), "kndl-pi-restart-"))
  })

  afterAll(() => {
    pi?.process.kill()
    hub?.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  test("after pi stops and starts again on the same conversation, the model's message resumes an agent on its saved conversation", async () => {
    pi = start()
    await hub.until(() => hub.hellos[0])
    hub.scripts.push(
      ofParent(
        toolCallReply(
          "agent",
          { description: "Remember a word", prompt: "Remember the word kiwi." },
          { input: 10, output: 2 },
        ),
      ),
      ofParent(textReply("Started.", { input: 10, output: 2 })),
      ofChild(textReply("I will remember kiwi.", { input: 10, output: 2 })),
      when(textReply("It remembers.", { input: 10, output: 2 }), "I will remember kiwi."),
    )
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q1", text: "remember", sender: ada })
    const events = await untilResultTurnEnds(hub, from)
    const agentId = String(events.find((event) => event._tag === "AgentStarted")?.agentId)
    const agents = join(home, "agent", "kndl", "agents")
    expect(existsSync(join(agents, `${agentId}.jsonl`))).toBe(true)
    expect(JSON.parse(readFileSync(join(agents, "index.json"), "utf8")).agents).toEqual([
      {
        agentId,
        description: "Remember a word",
        model: "openai/gpt-4.1",
        status: "Done",
        reported: true,
      },
    ])

    await stopPi(pi)
    pi = start()
    await hub.until(() => hub.hellos[1])
    expect(hub.hellos[1]?.conversationId).toBe(conversation)

    hub.scripts.push(
      ofParent(
        toolCallReply(
          "message_agent",
          { agentId, message: "Which word?" },
          { input: 10, output: 2 },
        ),
      ),
      ofParent(textReply("Asked it.", { input: 10, output: 2 })),
      ofChild(textReply("The word was kiwi.", { input: 10, output: 2 })),
      when(textReply("It said kiwi.", { input: 10, output: 2 }), "The word was kiwi."),
    )
    const requests = hub.gatewayRequests.length
    const resumed = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId: "q2", text: "which?", sender: ada })
    const again = await untilResultTurnEnds(hub, resumed)
    expect(resultTurn(again)).toMatchObject({
      text: expect.stringContaining("<result>The word was kiwi.</result>"),
      sender: { _tag: "FromAgent", agentId },
    })
    // It remembered: its request carried its saved conversation.
    const child = hub.gatewayRequests
      .slice(requests)
      .find((request) => JSON.stringify(request.body).includes(childNote))
    const asked = JSON.stringify(child?.body)
    expect(asked).toContain("Remember the word kiwi.")
    expect(asked).toContain("I will remember kiwi.")
    expect(asked).toContain("Which word?")
  }, 60_000)
})
