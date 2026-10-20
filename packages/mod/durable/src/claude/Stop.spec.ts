// A stopped turn and the prompt cache: a real Pi Durable Harness runs Claude's turns through the
// bridge, with Claude Code's query replaced by one that keeps a session file as Claude Code does,
// with the attachments Claude Code puts on each prompt (FakeTranscript). The turn after a stopped
// one must resume the same session, its request starting as the stopped turn's did: rebuilding the
// session from the conversation loses those attachments, and the prompt cache with them.
//
// Pi Durable leaves a stopped reply, and one that failed, out of what it sends: the turn after one
// carries the stopped prompt and the next as one user turn, and the stopped prompt, which Claude
// Code's session has already, stays there.

import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getProjectDir, normalizeProjectPath } from "cc-session-io"
import { ask, context, deferred, startDurable, transcript } from "./testing/Durable.ts"
import type { DurableBridge } from "./testing/Durable.ts"
import {
  apiError,
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

/** No retries, unless a test asks: a failed turn fails. */
const NoRetry = { retry: { enabled: false } } as never

/** A reply that streams `partial`, then holds until it's stopped, saying when it's reached. */
const stoppedReply = (partial: string) => {
  const reached = deferred()
  return {
    reached: reached.promise,
    steps: [init("cc"), ...partialText(partial, `msg_${partial}`), untilKilled(reached.resolve)],
  }
}

/** Submits `prompt`, and stops it once Claude Code is at `reached`. */
async function stop(bridge: DurableBridge, prompt: string, reached: Promise<void>) {
  const submission = await bridge.conversation.submit({ type: "input", content: prompt }, context)
  await reached
  await bridge.conversation.abort(context)
  return submission.wait(context)
}

/** Claude Code's session files, in the directory the queries ran in. */
const sessionFiles = (bridge: DurableBridge) =>
  readdirSync(getProjectDir(normalizeProjectPath(bridge.dir), bridge.claudeDir)).filter((file) =>
    file.endsWith(".jsonl"),
  )

const script = (label: string, steps: ReadonlyArray<Step>) => ({ label, steps })
const answer = (label: string, reply: string) =>
  script(label, [init("cc"), ...text(reply, `msg_${label}`), result(reply)])

describe("the turn after a stopped one", () => {
  test("resumes the same session, its request starting as the stopped turn's did", async () => {
    const bridge = await start({ settings: NoRetry })
    const stopped = stoppedReply("Once upon")
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("stopped", stopped.steps),
      answer("after", "Sure."),
    )
    await ask(bridge.conversation, "one")
    expect(await stop(bridge, "tell me a story", stopped.reached)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    })
    await ask(bridge.conversation, "three")

    const [first, stoppedCall, after] = bridge.fake.calls
    expect(stoppedCall?.options.resume).toBe(first?.sessionId)
    expect(after?.options.resume).toBe(first?.sessionId)
    expect(sessionFiles(bridge)).toEqual([`${first?.sessionId}.jsonl`])
    // Everything the stopped request held, Claude Code's attachments too, in its place.
    expect(stoppedCall?.request).toEqual([
      "user:one",
      "attachment:total_tokens_reminder",
      "assistant:Hello.",
      "user:tell me a story",
      "attachment:total_tokens_reminder",
    ])
    // The stopped prompt kept; the reply cut off, as Pi Durable leaves it out; the next prompt.
    expect(after?.prompt).toBe("three")
    expect(after?.request).toEqual([
      ...(stoppedCall?.request ?? []),
      "user:three",
      "attachment:total_tokens_reminder",
    ])
    expect((await transcript(bridge.conversation)).at(-1)).toBe("assistant:Sure.")
  })

  test("stopped before any output, goes on from its prompt", async () => {
    const bridge = await start({ settings: NoRetry })
    const reached = deferred()
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("stopped", [init("cc"), untilKilled(reached.resolve)]),
      answer("after", "Sure."),
    )
    await ask(bridge.conversation, "one")
    await stop(bridge, "two", reached.promise)
    await ask(bridge.conversation, "three")

    const [first, stoppedCall, after] = bridge.fake.calls
    expect(after?.options.resume).toBe(first?.sessionId)
    expect(after?.request).toEqual([
      ...(stoppedCall?.request ?? []),
      "user:three",
      "attachment:total_tokens_reminder",
    ])
  })

  test("after stops in a row, still resumes the same session", async () => {
    const bridge = await start({ settings: NoRetry })
    const second = stoppedReply("Once")
    const third = stoppedReply("Twice")
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("stopped", second.steps),
      script("stopped again", third.steps),
      answer("after", "Sure."),
    )
    await ask(bridge.conversation, "one")
    await stop(bridge, "two", second.reached)
    await stop(bridge, "three", third.reached)
    await ask(bridge.conversation, "four")

    const [first, , stoppedAgain, after] = bridge.fake.calls
    for (const call of bridge.fake.calls.slice(1))
      expect(call.options.resume).toBe(first?.sessionId)
    expect(sessionFiles(bridge)).toHaveLength(1)
    expect(stoppedAgain?.prompt).toBe("three")
    expect(after?.prompt).toBe("four")
    expect(after?.request).toEqual([
      ...(stoppedAgain?.request ?? []),
      "user:four",
      "attachment:total_tokens_reminder",
    ])
  })

  // Claude Code goes on writing for a moment after it's told to stop. Cutting the session back
  // before it exits would leave what it writes last after the conversation's messages.
  test("waits for the stopped Claude Code to exit before cutting its session back", async () => {
    const bridge = await start({ settings: NoRetry, fake: { process: { lateMs: 300 } } })
    const stopped = stoppedReply("Once upon")
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("stopped", stopped.steps),
      answer("after", "Sure."),
    )
    await ask(bridge.conversation, "one")
    await stop(bridge, "tell me a story", stopped.reached)
    await ask(bridge.conversation, "three")
    // Past when the stopped one wrote its last, had nothing waited for it.
    await Bun.sleep(400)

    const [first, stoppedCall, after] = bridge.fake.calls
    expect(after?.options.resume).toBe(first?.sessionId)
    expect(after?.request).toEqual([
      ...(stoppedCall?.request ?? []),
      "user:three",
      "attachment:total_tokens_reminder",
    ])
    const file = join(
      getProjectDir(normalizeProjectPath(bridge.dir), bridge.claudeDir),
      `${first?.sessionId}.jsonl`,
    )
    expect(readFileSync(file, "utf8")).not.toContain("[Request interrupted by user]")
  })

  test("stopped while a tool ran, goes on with the call and its result as the conversation holds them", async () => {
    const bridge = await start({ settings: NoRetry })
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("stopped", [
        init("cc"),
        ...toolUse("toolu_wait", "gate"),
        callTool("gate", "toolu_wait"),
      ]),
      answer("after", "Sure."),
    )
    await ask(bridge.conversation, "one")
    await stop(bridge, "wait, please", bridge.gate.started)
    await ask(bridge.conversation, "three")

    const [first, stoppedCall, after] = bridge.fake.calls
    expect(stoppedCall?.closed).toBe(true)
    expect(after?.options.resume).toBe(first?.sessionId)
    expect(after?.request).toEqual([
      ...(stoppedCall?.request ?? []),
      "assistant:tool_use:toolu_wait",
      "user:tool_result:toolu_wait",
      "user:three",
      "attachment:total_tokens_reminder",
    ])
    // The spike's bug: the tool call's message the Harness holds is as the turn ended it.
    const view = await bridge.conversation.context(context)
    const call = view.messages.find(
      (message) =>
        message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
    )
    expect(call).toMatchObject({ stopReason: "toolUse" })
  })
})

// Claude Code reports a failed API request (an overload, a 529) as a result with `is_error`, and
// writes the failure into its session. Pi Durable retries such a turn on the history before it,
// and the retry, like the next prompt, must resume the same session, with its history, without
// Claude Code's record of the failure.
describe("the turn after an API error", () => {
  const overloaded = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'

  test("the retry resumes the same session, its request as the failed one's", async () => {
    const bridge = await start({
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } as never,
    })
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("failed", [init("cc"), ...apiError(overloaded)]),
      answer("retried", "Sure."),
    )
    await ask(bridge.conversation, "one")
    expect((await ask(bridge.conversation, "two")).status).toBe("done")

    const [first, failed, retried] = bridge.fake.calls
    expect(bridge.fake.calls).toHaveLength(3)
    expect(failed?.options.resume).toBe(first?.sessionId)
    expect(retried?.options.resume).toBe(first?.sessionId)
    expect(retried?.request).toEqual(failed?.request)
    expect(retried?.request).toEqual([
      "user:one",
      "attachment:total_tokens_reminder",
      "assistant:Hello.",
      "user:two",
      "attachment:total_tokens_reminder",
    ])
    expect(sessionFiles(bridge)).toEqual([`${first?.sessionId}.jsonl`])
    expect((await transcript(bridge.conversation)).at(-1)).toBe("assistant:Sure.")
  })

  test("the next prompt resumes the same session, without Claude Code's record of the failure", async () => {
    const bridge = await start({ settings: NoRetry })
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("failed", [init("cc"), ...apiError(overloaded)]),
      answer("after", "Sure."),
    )
    await ask(bridge.conversation, "one")
    expect((await ask(bridge.conversation, "two")).status).toBe("unanswered")
    await ask(bridge.conversation, "three")

    const [first, failed, after] = bridge.fake.calls
    expect(after?.options.resume).toBe(first?.sessionId)
    expect(after?.request).toEqual([
      ...(failed?.request ?? []),
      "user:three",
      "attachment:total_tokens_reminder",
    ])
  })
})

describe("a run that ends with its query held at a tool call", () => {
  // A tool can end the run after its round, and Pi Durable then calls the model no more: the
  // query held at the call lives on. The next prompt follows the call's result in the
  // conversation as a steer would, and goes to it as one, with the result: Claude Code's session
  // then holds what the conversation does, the cache with it.
  test("the next prompt goes on in the held query, with the call's result", async () => {
    const bridge = await start({ settings: NoRetry })
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      script("finished", [
        init("cc"),
        ...toolUse("toolu_finish", "finish"),
        callTool("finish", "toolu_finish"),
        ...text("Sure.", "msg_next"),
        result("Sure."),
      ]),
    )
    await ask(bridge.conversation, "one")
    await ask(bridge.conversation, "finish up")
    const [first, finished] = bridge.fake.calls
    expect(finished?.closed).toBe(false)
    expect(finished?.options.resume).toBe(first?.sessionId)

    expect((await ask(bridge.conversation, "next")).status).toBe("done")
    expect(bridge.fake.calls).toHaveLength(2)
    expect(finished?.steers).toEqual(["next"])
    expect(await transcript(bridge.conversation)).toEqual([
      "user:one",
      "assistant:Hello.",
      "user:finish up",
      "assistant:call:finish",
      "toolResult:finished",
      "user:next",
      "assistant:Sure.",
    ])
  })
})

describe("a stop while the turn waits for a stopped Claude Code to exit", () => {
  test("ends the turn at once, and starts no query", async () => {
    const bridge = await start({ settings: NoRetry, fake: { process: { lateMs: 3_000 } } })
    const stopped = stoppedReply("Once upon")
    bridge.fake.scripts.push(answer("first", "Hello."), script("stopped", stopped.steps))
    await ask(bridge.conversation, "one")
    await stop(bridge, "tell me a story", stopped.reached)
    // Its Claude Code goes on for 3 seconds: the next turn waits for it, and is stopped.
    const waiting = await bridge.conversation.submit({ type: "input", content: "three" }, context)
    await Bun.sleep(100)
    const stoppedAt = performance.now()
    await bridge.conversation.abort(context)
    expect((await waiting.wait(context)).status).toBe("unanswered")
    expect(performance.now() - stoppedAt).toBeLessThan(1_000)
    expect(bridge.fake.calls).toHaveLength(2)
  }, 15_000)
})

// A query stopped can be slow to end: its Claude Code may keep the session file open for a moment.
// Everything the conversation started waits for it, a prompt stopped while it waited included, or
// a third query would resume the session file the first may still be writing.
describe("prompts in a row while a stopped query hasn't ended", () => {
  test("a prompt after one stopped while it waited still waits for the first query to end", async () => {
    const bridge = await start({ settings: NoRetry })
    const slow = deferred()
    bridge.fake.scripts.push(
      answer("first", "Hello."),
      // Held at a tool call the run is stopped at, and slow to end once it is stopped itself.
      script("held", [
        init("cc"),
        ...toolUse("toolu_wait", "gate"),
        // One step: a killed query reads no further steps, and this one outlasts the kill.
        async (stepContext) => {
          await callTool("gate", "toolu_wait")(stepContext)
          await slow.promise
        },
      ]),
      answer("third", "Sure."),
    )
    await ask(bridge.conversation, "one")
    await stop(bridge, "wait, please", bridge.gate.started)
    const [, held] = bridge.fake.calls

    // The next prompt stops the held query, and waits for it to end; it is stopped there.
    const second = await bridge.conversation.submit({ type: "input", content: "two" }, context)
    await Bun.sleep(50)
    expect(held?.closed).toBe(true)
    await bridge.conversation.abort(context)
    expect((await second.wait(context)).status).toBe("unanswered")

    const third = await bridge.conversation.submit({ type: "input", content: "three" }, context)
    await Bun.sleep(100)
    // The held query's Claude Code hasn't ended: no query resumes its session.
    expect(bridge.fake.calls).toHaveLength(2)

    slow.resolve()
    expect((await third.wait(context)).status).toBe("done")
    expect(bridge.fake.calls).toHaveLength(3)
    expect((await transcript(bridge.conversation)).at(-1)).toBe("assistant:Sure.")
  })
})
