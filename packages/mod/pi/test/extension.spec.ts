// kndl's pi extension end to end: the real pi (`--mode rpc`) loads the built extension, links to
// a fake Hub, and runs its models through the fake Hub's Gateway. Skipped when pi can't run here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { FakeHub, hangingReply, textReply, toolCallReply } from "./FakeHub.ts"

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

describe.skipIf(cannotRun !== undefined)("kndl's pi extension, in pi", () => {
  let hub: FakeHub
  let pi: Subprocess<"pipe", "pipe", "pipe">
  let home: string
  let stderr = ""

  beforeAll(async () => {
    // The bundle pi loads, from the sources as they are now.
    const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: root, stdout: "ignore" })
    if (built.exitCode !== 0 || !existsSync(extension))
      throw new Error("couldn't build the pi extension")
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
    pi = Bun.spawn(
      [
        "node",
        piCli,
        "--mode",
        "rpc",
        "-e",
        extension,
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--model",
        "openai/gpt-4.1",
      ],
      {
        cwd: home,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          KNDL_URL: hub.url,
          KNDL_MOD_TOKEN: modToken,
          KNDL_SESSION_ID: sessionId,
        },
      },
    )
    void (async () => {
      for await (const chunk of pi.stderr) stderr += new TextDecoder().decode(chunk)
    })()
    // pi's RPC records go to stdout; read them so pi never stalls on a full pipe.
    void (async () => {
      for await (const _ of pi.stdout);
    })()
  })

  afterAll(async () => {
    pi?.kill()
    hub?.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  const debug = () => {
    const log = join(home, "agent", "kndl.log")
    return `stderr: ${stderr}\nkndl.log: ${existsSync(log) ? readFileSync(log, "utf8") : "(none)"}`
  }

  test("says hello once pi's session is known: its conversation, its model, and that it steers, attaches and switches models", async () => {
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
    expect(first?.path).toBe("/gateway/models/openai/responses")
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
    expect(request?.path).toBe("/gateway/models/xai/responses")
    expect(request?.body.model).toBe("grok-4.3")
    expect(request?.body.reasoning).toMatchObject({ effort: "low" })
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

  test("commands for subagents and questions fail, saying why, until pi has them", async () => {
    const from = hub.events.length
    hub.send({ _tag: "StopAgent", sessionId, agentId: "a1" })
    const events = await hub.eventsUntil(from, (event) => event._tag === "AgentCommandFailed")
    expect(events.at(-1)).toMatchObject({ agentId: "a1", command: "StopAgent" })
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

  test("leaves pi when its session ends", async () => {
    pi.stdin.end()
    const exited = await Promise.race([
      pi.exited,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000)),
    ])
    expect(exited).not.toBe("hung")
  }, 20_000)
})
