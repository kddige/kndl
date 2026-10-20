// Claude's Models in the agent's Models: the Hub listing other Claude Models (a person picked one
// it hadn't listed) makes a provider for them, around the bridge the conversations are already
// running on. Everything the bridge holds (a turn streaming, a held query, the mirrors) goes on.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import type { ProviderModel } from "@kndl/protocol"
import { createClaudeBridgeProvider } from "./claude/index.ts"
import { deferred } from "./claude/testing/Durable.ts"
import {
  callTool,
  FakeClaudeCode,
  init,
  partialText,
  result,
  text,
  toolUse,
  untilKilled,
} from "./claude/testing/FakeClaudeCode.ts"
import { installClaude } from "./ClaudeModels.ts"
import type { ClaudeInstall } from "./ClaudeModels.ts"

const listing = (...ids: ReadonlyArray<string>): Array<ProviderModel> =>
  ids.map((id) => ({ provider: "anthropic", id, label: id, thinkingLevels: [] }))

let dir: string | undefined
let install: ClaudeInstall | undefined
afterEach(async () => {
  await install?.close()
  install = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** The Claude bridge installed on a fake Claude Code that keeps its sessions in a directory. */
function setup(ids: ReadonlyArray<string>) {
  dir = mkdtempSync(join(tmpdir(), "kndl-claude-models-"))
  const claudeDir = join(dir, "claude")
  const fake = new FakeClaudeCode({ claudeDir })
  const models = createModels()
  install = installClaude(models, listing(...ids), {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "[redacted]",
      KNDL_CLAUDE_CODE: "/opt/claude",
      CLAUDE_CONFIG_DIR: claudeDir,
    },
    cwd: dir,
    log: () => {},
    create: (options) => createClaudeBridgeProvider({ ...options, query: fake.query }),
  })
  const provider = () => {
    const found = models.getProvider("anthropic")
    if (found === undefined) throw new Error("no anthropic provider")
    return found
  }
  return {
    models,
    fake,
    provider,
    update: (next: ReadonlyArray<string>) => install?.update(listing(...next)),
  }
}

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp })
const event = (value: Record<string, unknown>) => ({ type: "stream_event", event: value })
// A tool, which the fake Claude Code's steps that wait on the test need served.
const tools = [
  { name: "echo", description: "Answers.", parameters: { type: "object", properties: {} } },
]
const request = (messages: ReadonlyArray<unknown>): TranscriptContext =>
  normalizeContext({ messages, tools } as never)

describe("the Hub listing other Claude Models", () => {
  test("makes a provider for them, around the same bridge", async () => {
    const { provider, update } = setup(["claude-haiku-5-5"])
    const before = provider()
    expect(before.getModels().map((model) => model.id)).toEqual(["claude-haiku-5-5"])

    update(["claude-haiku-5-5", "claude-sonnet-5-5"])

    const after = provider()
    expect(after).not.toBe(before)
    expect(after.getModels().map((model) => model.id)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ])
  })

  test("leaves a turn that is streaming to go on, and the conversation's mirror as it is", async () => {
    const { fake, provider, update } = setup(["claude-haiku-5-5"])
    const reached = deferred()
    const release = deferred()
    fake.scripts.push(
      {
        label: "streaming",
        steps: [
          init("cc"),
          ...partialText("Once upon"),
          async () => {
            reached.resolve()
            await release.promise
          },
          // The rest of the same message.
          event({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: " a time." },
          }),
          event({ type: "content_block_stop", index: 0 }),
          event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
          event({ type: "message_stop" }),
          result("Once upon a time."),
        ],
      },
      { label: "next", steps: [init("cc"), ...text("Again.", "msg_again"), result("Again.")] },
    )
    const model = provider().getModels()[0] as Model<Api>
    const streaming = provider().streamSimple(model, request([user("tell a story", 1)]), {
      sessionId: "conversation",
    })
    await reached.promise

    // The Hub lists another Claude Model while the turn streams.
    update(["claude-haiku-5-5", "claude-sonnet-5-5"])
    await Bun.sleep(20)
    expect(fake.calls[0]?.closed).toBe(false)

    release.resolve()
    const answer: AssistantMessage = await streaming.result()
    expect(answer.stopReason).toBe("stop")
    expect(answer.content).toEqual([{ type: "text", text: "Once upon a time." }])

    // The next request, on the new provider, resumes the session the first query kept.
    await provider()
      .streamSimple(model, request([user("tell a story", 1), answer, user("again", 3)]), {
        sessionId: "conversation",
      })
      .result()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.options.resume).toBe(fake.calls[0]?.sessionId)
  })

  test("takes the Claude Models away when none is listed, and brings them back on the same bridge", async () => {
    const { fake, models, provider, update } = setup(["claude-haiku-5-5"])
    const bridge = provider()
    update([])
    expect(models.getProvider("anthropic")).toBeUndefined()
    update(["claude-haiku-5-5"])
    expect(models.getProvider("anthropic")).toBeDefined()
    expect(fake.calls).toHaveLength(0)
    expect(bridge).not.toBe(provider())
  })

  test("the agent's report of a run settled still reaches the bridge", async () => {
    const { fake, provider, update } = setup(["claude-haiku-5-5"])
    fake.scripts.push({
      label: "held",
      steps: [
        init("cc"),
        ...toolUse("toolu_1", "echo"),
        callTool("echo", "toolu_1"),
        untilKilled(),
      ],
    })
    update(["claude-haiku-5-5", "claude-sonnet-5-5"])
    const model = provider().getModels()[0] as Model<Api>
    const held = await provider()
      .streamSimple(model, request([user("go", 1)]), { sessionId: "conversation" })
      .result()
    expect(held.stopReason).toBe("toolUse")
    expect(fake.calls[0]?.closed).toBe(false)

    install?.runSettled("conversation")

    expect(fake.calls[0]?.closed).toBe(true)
  })
})
