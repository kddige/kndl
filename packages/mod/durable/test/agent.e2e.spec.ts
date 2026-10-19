// The durable agent end to end: the built bundle (`dist/agent.js`) run by Node as the Runner runs
// it, linked to a fake Hub over HTTP, its model at the fake Hub's Gateway (OpenAI's Responses API)
// and one MCP server there. It answers a prompt with a tool call, stops on SIGTERM and comes back
// as the same conversation, and resumes a Turn after it was killed in the middle of a command.
// Skipped where Node can't run it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { FakeHub, textReply, toolCallReply, when } from "./FakeHub.ts"

const root = join(import.meta.dir, "../..")
const bundle = join(root, "durable/dist/agent.js")
const modToken = "tok-e2e-durable-5678"
const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

const cannotRun = (() => {
  const node = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "ignore" })
  if (node.exitCode !== 0) return "there is no node"
  const [major = 0, minor = 0] = node.stdout.toString().trim().slice(1).split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 19)) return `node ${major}.${minor} is too old`
  return undefined
})()
if (cannotRun !== undefined) console.warn(`skipping the durable agent's end-to-end test: ${cannotRun}`)

let hub: FakeHub
let dir: string
let agent: Subprocess<"ignore", "pipe", "pipe"> | undefined

/** Starts the bundle as the Runner would. */
const start = () => {
  agent = Bun.spawn(["node", bundle], {
    cwd: join(dir, "workspace"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: dir,
      KNDL_URL: hub.url,
      KNDL_MOD_TOKEN: modToken,
      KNDL_SESSION_ID: "s-e2e",
      KNDL_CONVERSATION_ID: "conv-e2e",
      KNDL_MODEL: "openai/gpt-4.1",
      KNDL_STATE_DIR: join(dir, "state"),
      KNDL_HARNESS: "Pi",
      KNDL_MCP_SERVERS: JSON.stringify([{ installationId: "inst1", server: "fake" }]),
    },
  })
  return agent
}

const log = () => {
  const file = join(dir, "state/durable/agent.log")
  return existsSync(file) ? readFileSync(file, "utf8") : ""
}

describe.skipIf(cannotRun !== undefined)("the durable agent's bundle", () => {
  beforeAll(() => {
    const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: root, stdout: "ignore", stderr: "pipe" })
    if (built.exitCode !== 0) throw new Error(built.stderr.toString())
    dir = mkdtempSync(join(tmpdir(), "kndl-durable-e2e-"))
    Bun.spawnSync(["mkdir", "-p", join(dir, "workspace")])
    hub = new FakeHub({
      modToken,
      providers: { models: [{ provider: "openai", id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] }] },
      attachments: {},
    })
  })

  afterAll(() => {
    agent?.kill("SIGKILL")
    hub?.stop()
    if (process.env.KNDL_TEST_LOG) console.log(log())
    rmSync(dir, { recursive: true, force: true })
  })

  test("answers a prompt through the Gateway, and stops and starts as the same conversation", async () => {
    start()
    const hello = await hub.until(() => hub.hellos[0])
    expect(hello).toMatchObject({
      sessionId: "s-e2e",
      conversationId: "conv-e2e",
      model: "openai/gpt-4.1",
      durable: true,
      switchesModels: true,
    })
    // Its MCP server connected, at the Gateway, with the Session token.
    await hub.until(() => hub.mcpRequests.find((request) => request.method === "tools/list"))
    hub.scripts.push(
      when(toolCallReply("bash", { command: "echo smoke-$((40+2))" }, { input: 30, output: 7 }), "function_call_output", true),
      when(textReply("The command said 42.", { input: 40, output: 6 }), "function_call_output"),
    )
    hub.send({ _tag: "DeliverPrompt", sessionId: "s-e2e", promptId: "q1", text: "Run it", sender: ada })
    const events = await hub.eventsUntil(0, (event) => event._tag === "TurnEnded")
    expect(events.map((event) => event._tag)).toEqual([
      "TurnStarted",
      "ToolCallStarted",
      "ToolCallEnded",
      "TextDelta",
      "TurnEnded",
    ])
    expect(events[2]).toMatchObject({ outcome: "Succeeded", output: expect.stringContaining("smoke-42") })
    expect(events[4]).toMatchObject({ reason: "stop", usage: { model: "openai/gpt-4.1", input: 70, output: 13 } })
    expect(hub.gatewayRequests[0]?.authorization).toBe(`Bearer ${modToken}`)
    expect(JSON.stringify(hub.gatewayRequests[0]?.body)).toContain("This session is shared through kndl")

    agent?.kill("SIGTERM")
    expect(await agent?.exited).toBe(0)
    expect(log()).toContain("SIGTERM: shutting down")
    expect(log()).not.toContain(modToken)

    hub.forget()
    start()
    const again = await hub.until(() => hub.hellos[1])
    expect(again).toMatchObject({ conversationId: "conv-e2e", model: "openai/gpt-4.1" })
  }, 30_000)

  test("resumes a Turn it was killed in the middle of", async () => {
    hub.scripts.push(
      when(toolCallReply("bash", { command: "sleep 60" }, { input: 10, output: 3 }), "Wait for it"),
      when(textReply("The sleep was cut off.", { input: 12, output: 5 }), "interrupted"),
    )
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId: "s-e2e", promptId: "q2", text: "Wait for it", sender: ada })
    await hub.eventsUntil(from, (event) => event._tag === "ToolCallStarted")
    await new Promise((resolve) => setTimeout(resolve, 300))
    agent?.kill("SIGKILL")
    await agent?.exited
    hub.forget()
    const resumedFrom = hub.events.length
    start()
    const events = await hub.eventsUntil(resumedFrom, (event) => event._tag === "TurnEnded")
    expect(events[0]).toMatchObject({ _tag: "TurnStarted", sender: { _tag: "Resumed" } })
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({ outcome: "Failed" })
    expect(events.at(-1)).toMatchObject({ reason: "stop" })
    // The prompt delivered again after the restart isn't run twice.
    hub.send({ _tag: "DeliverPrompt", sessionId: "s-e2e", promptId: "q2", text: "Wait for it", sender: ada })
    await hub.eventsUntil(resumedFrom, (event) => event._tag === "PromptAlreadySubmitted")
  }, 30_000)
})
