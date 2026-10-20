// The Claude bridge under a real Pi Durable Harness: Claude Code's query replaced by a fake that
// keeps its session files as Claude Code does (FakeClaudeCode), everything else as the durable
// agent runs it. What a provider can't be told (a run's end, a compaction, a restart), and the
// generation task's abort signal, which Pi Durable fires each time the task stops running, right
// after every turn that ends at a tool call, are what these are about.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { ProviderDoc } from "@earendil-works/pi-durable"
import { getSessionPath, normalizeProjectPath } from "cc-session-io"
import {
  ask,
  context,
  deferred,
  Echoed,
  SectionText,
  startDurable,
  transcript,
} from "./testing/Durable.ts"
import type { DurableBridge } from "./testing/Durable.ts"
import {
  callTool,
  init,
  partialText,
  result,
  text,
  toolUse,
  untilKilled,
} from "./testing/FakeClaudeCode.ts"
import type { Step } from "./testing/FakeClaudeCode.ts"

let env: DurableBridge | undefined
afterEach(async () => {
  await env?.dispose()
  env = undefined
})

const start = async (options: Parameters<typeof startDurable>[0] = {}) => {
  env = await startDurable(options)
  return env
}

/** A query's script: Claude Code's init, then `steps`. */
const script = (label: string, ...steps: Array<Step | ReadonlyArray<Step>>) => ({
  label,
  steps: [init("s"), ...steps.flat()],
})

/** The text Claude Code was told to append to its own system prompt. */
const appended = (options: Options) => {
  const prompt = options.systemPrompt
  return typeof prompt === "object" && prompt !== null && "append" in prompt
    ? prompt.append
    : undefined
}

/** The file Claude Code keeps `sessionId` in, in the directory the queries ran in. */
const sessionFile = (bridge: DurableBridge, sessionId: string) =>
  getSessionPath(sessionId, normalizeProjectPath(bridge.dir), bridge.claudeDir)

/** The provider session id of `env`'s root conversation. */
const providerSession = async (bridge: DurableBridge) =>
  (await bridge.harness.snapshot(ProviderDoc, bridge.conversation.id, context))?.sessionId ?? ""

describe("a turn", () => {
  test("streams Claude's answer, with the agent's sections appended and its tools served", async () => {
    const { fake, conversation } = await start()
    fake.scripts.push(script("answer", text("Ahoy."), result("Ahoy.")))

    const settled = await ask(conversation, "hello")

    expect(settled.status).toBe("done")
    expect(await transcript(conversation)).toEqual(["user:hello", "assistant:Ahoy."])
    const [call] = fake.calls
    expect(call?.prompt).toBe("hello")
    expect(call?.options.tools).toEqual([])
    expect(appended(call?.options ?? {})).toContain(SectionText)
    expect(call?.options.pathToClaudeCodeExecutable).toBe("/opt/kndl/claude-code/claude")
    expect(call?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-test")
    const served = Object.keys(
      (call?.options.mcpServers?.["custom-tools"] as { instance?: unknown }) ?? {},
    )
    expect(served).toContain("instance")
  })

  test("is keyed by the conversation's provider session id", async () => {
    const bridge = await start()
    bridge.fake.scripts.push(script("answer", text("Ahoy."), result("Ahoy.")))
    await ask(bridge.conversation, "hello")
    expect(bridge.calls[0]?.options?.sessionId).toBe(await providerSession(bridge))
  })
})

describe("a tool call", () => {
  test("is run by the Harness, and the same query goes on with its result", async () => {
    const { fake, conversation, calls } = await start()
    let answered: string | undefined
    fake.scripts.push(
      script(
        "tools",
        toolUse("toolu_1", "echo"),
        callTool("echo", "toolu_1", (reply) => {
          answered = reply.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
        }),
        text("It echoed."),
        result("It echoed."),
      ),
    )

    const settled = await ask(conversation, "call echo")

    expect(settled.status).toBe("done")
    expect(await transcript(conversation)).toEqual([
      "user:call echo",
      "assistant:call:echo",
      `toolResult:${Echoed}`,
      "assistant:It echoed.",
    ])
    // One query, answered over MCP, its tool call held across the generation task's invocations.
    expect(fake.calls).toHaveLength(1)
    expect(answered).toBe(Echoed)
    expect(calls).toHaveLength(2)
    // Pi Durable ended the first request's invocation as the task waited on its tool, which
    // aborted its signal: the query lived on.
    expect(calls[0]?.options?.signal?.aborted).toBe(true)
  })

  test("takes a steer placed after the tool round into the held query", async () => {
    const { fake, conversation, gate } = await start()
    fake.scripts.push(
      script(
        "steered",
        toolUse("toolu_1", "gate"),
        callTool("gate", "toolu_1"),
        text("Ok."),
        result("Ok."),
      ),
    )
    const submission = await conversation.submit({ type: "input", content: "wait" }, context)
    await gate.started
    await conversation.submit(
      { type: "input", content: "Use pnpm, not npm", whenBusy: "steer" },
      context,
    )
    gate.open()

    expect((await submission.wait(context)).status).toBe("done")
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.steers).toEqual(["Use pnpm, not npm"])
  })

  test("a tool loaded mid-run starts a query that serves it", async () => {
    const { fake, conversation } = await start()
    fake.scripts.push(
      script("loads", toolUse("toolu_1", "load"), callTool("load", "toolu_1"), untilKilled()),
      script("with later", text("Loaded."), result("Loaded.")),
    )

    expect((await ask(conversation, "load it")).status).toBe("done")

    expect(fake.calls.map((call) => call.closed)).toEqual([true, true])
    expect(fake.calls[1]?.prompt).toContain("The tools available to you changed")
    // The second query resumes the first's session, rebuilt from the conversation under its id.
    expect(fake.calls[1]?.options.resume).toBe(fake.calls[0]?.sessionId)
    expect(fake.calls[1]?.request).toEqual([
      "user:load it",
      "assistant:tool_use:toolu_1",
      "user:tool_result:toolu_1",
      expect.stringContaining("user:[The tools available to you changed"),
      "attachment:total_tokens_reminder",
    ])
  })
})

describe("Esc", () => {
  test("while Claude streams stops the query", async () => {
    const { fake, conversation } = await start()
    const streaming = deferred()
    fake.scripts.push(
      script("stopped", partialText("Once upon"), untilKilled(streaming.resolve), result("x")),
    )
    const submission = await conversation.submit({ type: "input", content: "story" }, context)
    await streaming.promise

    await conversation.abort(context)

    expect(await submission.wait(context)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    })
    expect(fake.calls[0]?.closed).toBe(true)
  })

  test("while Claude streams after a tool's result stops the query", async () => {
    const { fake, conversation } = await start()
    const streaming = deferred()
    fake.scripts.push(
      script(
        "stopped",
        toolUse("toolu_1", "echo"),
        callTool("echo", "toolu_1"),
        partialText("Now then"),
        untilKilled(streaming.resolve),
      ),
    )
    const submission = await conversation.submit({ type: "input", content: "go" }, context)
    await streaming.promise
    expect(fake.calls[0]?.closed).toBe(false)

    await conversation.abort(context)

    expect((await submission.wait(context)).status).toBe("unanswered")
    expect(fake.calls[0]?.closed).toBe(true)
  })

  test("while a tool runs leaves the query, which the next prompt stops and goes on from", async () => {
    const { fake, conversation, gate } = await start()
    fake.scripts.push(
      script(
        "held",
        toolUse("toolu_1", "gate"),
        callTool("gate", "toolu_1"),
        text("x"),
        result("x"),
      ),
      script("next", text("Next."), result("Next.")),
    )
    const submission = await conversation.submit({ type: "input", content: "wait" }, context)
    await gate.started

    await conversation.abort(context)
    expect((await submission.wait(context)).status).toBe("unanswered")
    // Nothing tells the provider the run ended: the query is held still.
    expect(fake.calls[0]?.closed).toBe(false)

    expect((await ask(conversation, "something else")).status).toBe("done")

    expect(fake.calls.map((call) => [call.label, call.closed])).toEqual([
      ["held", true],
      ["next", true],
    ])
    // The new prompt is the new query's, not a steer into the stopped run's.
    expect(fake.calls[0]?.steers).toEqual([])
    expect(fake.calls[1]?.prompt).toBe("something else")
    expect(fake.calls[1]?.options.resume).toBe(fake.calls[0]?.sessionId)
    expect(fake.calls[1]?.request).toEqual([
      "user:wait",
      "assistant:tool_use:toolu_1",
      "user:tool_result:toolu_1",
      "user:something else",
      "attachment:total_tokens_reminder",
    ])
  })

  test("while a later turn's tool runs: the next query's session is cut back, keeping Claude Code's own records", async () => {
    const { fake, conversation, gate } = await start()
    fake.scripts.push(
      script("first", text("Hello."), result("Hello.")),
      script(
        "held",
        toolUse("toolu_1", "gate"),
        callTool("gate", "toolu_1"),
        text("x"),
        result("x"),
      ),
      script("next", text("Next."), result("Next.")),
    )
    await ask(conversation, "hi")
    const submission = await conversation.submit({ type: "input", content: "wait" }, context)
    await gate.started
    await conversation.abort(context)
    await submission.wait(context)

    await ask(conversation, "something else")

    expect(fake.calls[2]?.options.resume).toBe(fake.calls[0]?.sessionId)
    // The attachments Claude Code put on each prompt stay, and the stopped query's prompt with
    // its own; what it wrote after is the conversation's.
    expect(fake.calls[2]?.request).toEqual([
      "user:hi",
      "attachment:total_tokens_reminder",
      "assistant:Hello.",
      "user:wait",
      "attachment:total_tokens_reminder",
      "assistant:tool_use:toolu_1",
      "user:tool_result:toolu_1",
      "user:something else",
      "attachment:total_tokens_reminder",
    ])
  })
})

describe("a compaction", () => {
  test("summarizes in a Claude Code of its own, and the next turn rebuilds the session", async () => {
    const { fake, conversation } = await start({
      settings: { compaction: { enabled: true, keepRecentTokens: 1 } } as never,
    })
    fake.scripts.push(
      script("first", text("One."), result("One.")),
      script("second", text("Two."), result("Two.")),
    )
    await ask(conversation, "one")
    await ask(conversation, "two")
    const session = fake.calls[0]?.sessionId
    expect(fake.calls[1]?.options.resume).toBe(session)

    fake.scripts.push({
      label: "summary",
      steps: [
        { type: "assistant", message: { content: [{ type: "text", text: "SUMMARY" }] } },
        result("SUMMARY"),
      ],
    })
    const task = await conversation.compact("keep it short", context)
    const compacted = await env?.harness.waitForTask(task, context)
    expect(compacted?.state).toMatchObject({ outcome: { status: "completed" } })
    const summary = fake.calls[2]
    expect(summary?.options.persistSession).toBe(false)
    expect(summary?.options.resume).toBeUndefined()
    expect(summary?.options.maxTurns).toBe(1)

    fake.scripts.push(script("after", text("Three."), result("Three.")))
    await ask(conversation, "three")

    const after = fake.calls[3]
    // Rebuilt from the compacted conversation, under the session's own id.
    expect(after?.options.resume).toBe(session)
    expect(after?.request?.[0]).toContain("SUMMARY")
    expect(after?.request).not.toContain("user:one")
    expect(after?.request?.slice(-3)).toEqual([
      "assistant:Two.",
      "user:three",
      "attachment:total_tokens_reminder",
    ])
  })
})

describe("two conversations at once", () => {
  test("a fork runs beside its parent's held query, each on a session of its own", async () => {
    const { fake, conversation, gate } = await start()
    fake.scripts.push(script("first", text("Hello."), result("Hello.")))
    const first = await ask(conversation, "hi")
    if (first.status !== "done" || first.type !== "input") throw new Error("the first turn failed")
    const fork = await conversation.fork(
      first.answer,
      { ownership: { kind: "ownerless" } },
      context,
    )

    fake.scripts.push(
      script(
        "root",
        toolUse("toolu_r", "gate"),
        callTool("gate", "toolu_r"),
        text("Root done."),
        result("Root done."),
      ),
      script("fork", text("Fork done."), result("Fork done.")),
    )
    const rootRun = await conversation.submit({ type: "input", content: "root task" }, context)
    await gate.started
    expect((await ask(fork, "fork task")).status).toBe("done")
    // The fork's query stopped nothing of the root's.
    expect(fake.calls[1]?.closed).toBe(false)
    gate.open()
    expect((await rootRun.wait(context)).status).toBe("done")

    expect(fake.calls.map((call) => call.label)).toEqual(["first", "root", "fork"])
    expect(fake.calls[1]?.options.resume).toBe(fake.calls[0]?.sessionId)
    // The fork's own session, rebuilt from the history it was forked with.
    expect(fake.calls[2]?.options.resume).toBeDefined()
    expect(fake.calls[2]?.options.resume).not.toBe(fake.calls[0]?.sessionId)
    expect(fake.calls[2]?.request).toEqual([
      "user:hi",
      "assistant:Hello.",
      "user:fork task",
      "attachment:total_tokens_reminder",
    ])
    expect(await transcript(conversation)).toEqual([
      "user:hi",
      "assistant:Hello.",
      "user:root task",
      "assistant:call:gate",
      `toolResult:${Echoed}`,
      "assistant:Root done.",
    ])
    expect(await transcript(fork)).toEqual([
      "user:hi",
      "assistant:Hello.",
      "user:fork task",
      "assistant:Fork done.",
    ])
  })
})

describe("a restart", () => {
  test("goes on from a tool's result by rebuilding Claude Code's session, under a new id", async () => {
    const bridge = await start({ storage: "jsonl" })
    const { fake, gate } = bridge
    fake.scripts.push(
      script(
        "before",
        toolUse("toolu_1", "gate"),
        callTool("gate", "toolu_1"),
        text("x"),
        result("x"),
      ),
    )
    const submission = await bridge.conversation.submit({ type: "input", content: "wait" }, context)
    await gate.started

    await bridge.reopen()
    expect(fake.calls[0]?.closed).toBe(true)
    fake.scripts.push(script("after", text("Resumed."), result("Resumed.")))
    bridge.harness.resume()
    const again = await bridge.harness.submission(submission.id, context)
    expect((await again?.wait(context))?.status).toBe("done")

    const after = fake.calls[1]
    expect(after?.prompt).toContain("Your session was interrupted and resumed")
    // The bridge before may have left its Claude Code writing to the session: rebuilt under a new
    // id, and the file it was in deleted.
    expect(after?.options.resume).toBeDefined()
    expect(after?.options.resume).not.toBe(fake.calls[0]?.sessionId)
    expect(existsSync(sessionFile(bridge, fake.calls[0]?.sessionId ?? ""))).toBe(false)
    expect(existsSync(sessionFile(bridge, after?.options.resume ?? ""))).toBe(true)
    expect(after?.request?.slice(0, 3)).toEqual([
      "user:wait",
      "assistant:tool_use:toolu_1",
      "user:tool_result:toolu_1",
    ])
    expect((await transcript(bridge.conversation)).at(-1)).toBe("assistant:Resumed.")
  })
})

describe("a held query no request comes back to", () => {
  test("is stopped after a while", async () => {
    const { fake, conversation } = await start({ bridge: { idleQueryMs: 50 } })
    fake.scripts.push(
      script("held", toolUse("toolu_1", "finish"), callTool("finish", "toolu_1"), untilKilled()),
    )
    // The tool ends the run, with no further request.
    expect((await ask(conversation, "finish")).status).toBe("done")
    expect(fake.calls[0]?.closed).toBe(false)

    await Bun.sleep(300)
    expect(fake.calls[0]?.closed).toBe(true)
  })
})

/** A run that ends with its query held at a tool call. */
const heldAtFinish = () =>
  script("held", toolUse("toolu_1", "finish"), callTool("finish", "toolu_1"), untilKilled())

// The agent tells the bridge when a conversation's run settled: a query held at a tool call that
// no request comes back to is stopped then, not left to the reaper.
describe("a conversation's run settling", () => {
  test("stops the query held at a tool call, which no request comes back to", async () => {
    const bridge = await start()
    bridge.fake.scripts.push(heldAtFinish())
    expect((await ask(bridge.conversation, "finish")).status).toBe("done")
    expect(bridge.fake.calls[0]?.closed).toBe(false)

    bridge.provider.runSettled(await providerSession(bridge))

    expect(bridge.fake.calls[0]?.closed).toBe(true)
  })

  test("goes on with the conversation's next prompt in a query of its own", async () => {
    const bridge = await start()
    bridge.fake.scripts.push(heldAtFinish(), script("next", text("Sure."), result("Sure.")))
    await ask(bridge.conversation, "finish")
    bridge.provider.runSettled(await providerSession(bridge))

    expect((await ask(bridge.conversation, "next")).status).toBe("done")
    expect(bridge.fake.calls).toHaveLength(2)
    expect(bridge.fake.calls[1]?.steers).toEqual([])
    expect((await transcript(bridge.conversation)).at(-1)).toBe("assistant:Sure.")
  })

  test("leaves a query with a turn open alone", async () => {
    const bridge = await start()
    const reached = deferred()
    bridge.fake.scripts.push(
      script("streaming", partialText("Once upon"), untilKilled(reached.resolve)),
    )
    const submission = await bridge.conversation.submit(
      { type: "input", content: "story" },
      context,
    )
    await reached.promise

    bridge.provider.runSettled(await providerSession(bridge))
    await Bun.sleep(20)
    expect(bridge.fake.calls[0]?.closed).toBe(false)

    await bridge.conversation.abort(context)
    await submission.wait(context)
  })

  test("is no matter for a conversation the bridge doesn't know", async () => {
    const bridge = await start()
    expect(() => bridge.provider.runSettled("no-such-conversation")).not.toThrow()
  })
})
