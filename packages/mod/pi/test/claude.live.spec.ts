// The Claude bridge against the real Claude, through the pinned Claude Code, in real pi, linked to
// a fake Hub: a turn that reads a file with pi's tool, one that reads and then runs bash, one that
// reads two files in one message, a turn aborted while its bash call runs, a turn after it, then a
// switch to GPT (on the fake Hub's Gateway), whose request must still carry the aborted turn's
// tool call with its result (the spike's bug), and back on Claude, read then bash again.
//
// It spends a few Haiku turns of a real subscription, so it runs only when asked:
//   KNDL_CLAUDE_IT=1 CLAUDE_CODE_OAUTH_TOKEN=… [KNDL_CLAUDE_CODE=…/claude] bun test pi/test/claude.live.spec.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { FakeHub, textReply } from "./FakeHub.ts"

const root = join(import.meta.dir, "../..")
const extension = join(root, "pi/dist/kndl.js")
const piCli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
const claudeCode = process.env.KNDL_CLAUDE_CODE ?? "/opt/kndl/claude-code/2.1.296-glibc/claude"
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN

const skip = (() => {
  if (process.env.KNDL_CLAUDE_IT !== "1") return "KNDL_CLAUDE_IT=1 isn't set"
  if (!token) return "there's no CLAUDE_CODE_OAUTH_TOKEN"
  if (!existsSync(claudeCode)) return `there's no Claude Code at ${claudeCode}`
  if (!existsSync(piCli)) return "pi isn't installed"
  return undefined
})()
if (skip !== undefined && process.env.KNDL_CLAUDE_IT === "1")
  console.warn(`skipping the Claude bridge's live test: ${skip}`)

const modToken = "tok-live"
const sessionId = "s-live"
const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }
const word = "periwinkle"
const noteLines = ["one", "two", "three", "four", "five", "six", "seven"]

/** A prompt that needs a second tool call after the first's result, in one Claude turn. */
const readThenBash =
  "Read note.txt with your read tool. Then, as a separate step after reading it, use your bash " +
  "tool to count the lines of note.txt with `wc -l note.txt`. Then answer with the line count."

/** A log's end, for a failure's message. */
const read = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").slice(-6000) : "(none)"

/** What the model said in a Turn. */
const said = (events: ReadonlyArray<Record<string, unknown>>) =>
  events
    .filter((event) => event._tag === "TextDelta")
    .map((event) => event.text)
    .join("")

/** That a Turn called `tool`, and it succeeded. */
const expectToolRan = (events: ReadonlyArray<Record<string, unknown>>, tool: string) => {
  expect(events).toContainEqual(expect.objectContaining({ _tag: "ToolCallStarted", tool }))
  expect(events).toContainEqual(
    expect.objectContaining({ _tag: "ToolCallEnded", tool, outcome: "Succeeded" }),
  )
}

describe.skipIf(skip !== undefined)("the Claude bridge, live", () => {
  let hub: FakeHub
  let pi: Subprocess<"pipe", "pipe", "pipe">
  let home: string
  let stderr = ""

  beforeAll(() => {
    const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: root, stdout: "ignore" })
    if (built.exitCode !== 0 || !existsSync(extension))
      throw new Error("couldn't build the pi extension")
    hub = new FakeHub({
      modToken,
      providers: {
        models: [
          {
            provider: "anthropic",
            id: "claude-haiku-5-5",
            label: "Claude Haiku 5.5",
            thinkingLevels: [],
          },
          { provider: "openai", id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] },
        ],
      } as never,
      attachments: {},
    })
    home = mkdtempSync(join(tmpdir(), "kndl-claude-live-"))
    const workspace = join(home, "workspace")
    mkdirSync(workspace)
    writeFileSync(join(workspace, "secret.txt"), `The secret word is ${word}.\n`)
    writeFileSync(join(workspace, "note.txt"), noteLines.map((line) => `${line}\n`).join(""))
    writeFileSync(join(workspace, "a.txt"), "The first colour is vermilion.\n")
    writeFileSync(join(workspace, "b.txt"), "The second colour is cerulean.\n")
    pi = Bun.spawn(
      [
        "node",
        piCli,
        "--mode",
        "rpc",
        "-e",
        extension,
        "--no-skills",
        "--no-context-files",
        "--session-id",
        crypto.randomUUID(),
        "--model",
        "anthropic/claude-haiku-5-5",
      ],
      {
        cwd: workspace,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          KNDL_URL: hub.url,
          KNDL_MOD_TOKEN: modToken,
          KNDL_SESSION_ID: sessionId,
          CLAUDE_CODE_OAUTH_TOKEN: token ?? "",
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          IS_SANDBOX: "1",
          KNDL_CLAUDE_CODE: claudeCode,
          KNDL_CLAUDE_DEBUG: "1",
          // What the bridge must keep from Claude Code.
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ANTHROPIC_API_KEY: "sk-ant-api-not-this",
        },
      },
    )
    void (async () => {
      for await (const chunk of pi.stderr) stderr += new TextDecoder().decode(chunk)
    })()
    // Read, though unused: pi's RPC mode waits for stdout to drain before each agent event, so a
    // pipe nobody reads stalls pi's turn once it fills.
    void (async () => {
      for await (const _ of pi.stdout);
    })()
  })

  afterAll(() => {
    pi?.kill()
    hub?.stop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  const debug = () => {
    return `stderr: ${stderr}\nkndl.log: ${read(join(home, "agent", "kndl.log"))}\nclaude-bridge.log: ${read(join(home, "agent", "claude-bridge.log"))}`
  }
  const turn = async (promptId: string, text: string) => {
    const from = hub.events.length
    hub.send({ _tag: "DeliverPrompt", sessionId, promptId, text, sender: ada })
    const events = await hub
      .eventsUntil(from, (event) => event._tag === "TurnEnded", 120_000)
      .catch((error: unknown) => {
        throw new Error(`${error}\n${debug()}`)
      })
    console.log(`${promptId}: ${JSON.stringify(events.at(-1))}`)
    return events
  }
  test("a Claude turn reads a file with pi's read tool", async () => {
    await hub.until(() => hub.hellos[0], 60_000)
    expect(hub.hellos[0]).toMatchObject({ model: "anthropic/claude-haiku-5-5" })
    const events = await turn(
      "q1",
      "Use your read tool to read secret.txt, then tell me the secret word in it.",
    )
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "ToolCallStarted", tool: "read" }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "ToolCallEnded", tool: "read", outcome: "Succeeded" }),
    )
    expect(said(events).toLowerCase()).toContain(word)
    expect(events.at(-1)).toMatchObject({
      _tag: "TurnEnded",
      reason: "stop",
      usage: { model: "anthropic/claude-haiku-5-5" },
    })
  }, 180_000)

  // A tool call from the held query, once the first one's result is in.
  test("a Claude turn calls a second tool after the first's result", async () => {
    const events = await turn("q-two-tools", readThenBash)
    expectToolRan(events, "read")
    expectToolRan(events, "bash")
    expect(said(events)).toContain(String(noteLines.length))
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "stop" })
  }, 180_000)

  test("a Claude turn calls two tools in one message", async () => {
    const events = await turn(
      "q-parallel",
      "Read a.txt and b.txt with your read tool, calling it for both files in parallel in one " +
        "message, then tell me both colours.",
    )
    const reads = events.filter(
      (event) => event._tag === "ToolCallStarted" && event.tool === "read",
    ).length
    console.log(`q-parallel: ${reads} read calls`)
    expect(reads).toBeGreaterThanOrEqual(2)
    const answer = said(events).toLowerCase()
    expect(answer).toContain("vermilion")
    expect(answer).toContain("cerulean")
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "stop" })
  }, 180_000)

  test("a Claude turn stops while its bash call runs", async () => {
    const from = hub.events.length
    hub.send({
      _tag: "DeliverPrompt",
      sessionId,
      promptId: "q2",
      text: "Run exactly this command with your bash tool and nothing else: sleep 60",
      sender: ada,
    })
    await hub
      .eventsUntil(
        from,
        (event) => event._tag === "ToolCallStarted" && event.tool === "bash",
        120_000,
      )
      .catch((error: unknown) => {
        throw new Error(`${error}\n${debug()}`)
      })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    hub.send({ _tag: "StopTurn", sessionId })
    const events = await hub.eventsUntil(from, (event) => event._tag === "TurnEnded", 60_000)
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "aborted" })
  }, 180_000)

  test("the next Claude turn goes on from the conversation", async () => {
    const events = await turn("q3", "What was the secret word? Answer with the word alone.")
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "stop" })
    expect(said(events).toLowerCase()).toContain(word)
  }, 180_000)

  test("switching to GPT replays the aborted turn's tool call with its result", async () => {
    hub.send({ _tag: "SwitchModel", sessionId, model: "openai/gpt-4.1" })
    hub.scripts.push(textReply("Noted.", { input: 10, output: 2 }))
    const requests = hub.gatewayRequests.length
    const events = await turn("q4", "Thanks.")
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "stop" })
    const input = (hub.gatewayRequests[requests]?.body.input ?? []) as Array<{
      type?: string
      call_id?: string
      name?: string
    }>
    const calls = new Set(
      input.filter((item) => item.type === "function_call").map((item) => item.call_id),
    )
    const outputs = input.filter((item) => item.type === "function_call_output")
    expect(input.some((item) => item.type === "function_call" && item.name === "bash")).toBe(true)
    expect(outputs.length).toBeGreaterThanOrEqual(2)
    for (const output of outputs) expect(calls.has(output.call_id)).toBe(true)
  }, 60_000)

  // Back from GPT, the mirror rebuilds, and the query runs on the rebuilt session.
  test("back on Claude after GPT, a turn calls a second tool after the first's result", async () => {
    hub.send({ _tag: "SwitchModel", sessionId, model: "anthropic/claude-haiku-5-5" })
    const events = await turn("q-two-tools-rebuilt", readThenBash)
    expectToolRan(events, "read")
    expectToolRan(events, "bash")
    expect(said(events)).toContain(String(noteLines.length))
    expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "stop" })
  }, 180_000)
})
