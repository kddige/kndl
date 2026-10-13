// HubLink against a real Hub (packages/hub's test Hub on 127.0.0.1): the hello, a prompt from the
// queue delivered as a command, the Turn's events landing in the Session's log, and a Hub restart
// answered by saying hello again and polling from after=0.

import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { databaseAt } from "@kndl/hub/src/Database.ts"
import { ModOutbox } from "@kndl/hub/src/ModOutbox.ts"
import { ModTokens } from "@kndl/hub/src/ModTokens.ts"
import { PromptQueue } from "@kndl/hub/src/PromptQueue.ts"
import { RunnerTokens } from "@kndl/hub/src/RunnerTokens.ts"
import { SessionLog } from "@kndl/hub/src/SessionLog.ts"
import { Sessions } from "@kndl/hub/src/Sessions.ts"
import { devSignIn, startHub, stopHubs } from "@kndl/hub/src/testSupport.ts"
import type { TestHub } from "@kndl/hub/src/testSupport.ts"
import { ModCommand, ParticipantId, PromptId, SessionId } from "@kndl/protocol"
import type { Participant } from "@kndl/protocol"
import { Effect } from "effect"
import { HubLink } from "./HubLink.ts"
import type { HubFetch, LinkStatus } from "./HubLink.ts"
import { promptFromParticipant } from "./HubMessages.ts"

afterEach(stopHubs)

const scratch = mkdtempSync(join(tmpdir(), "kndl-mod-link-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const sessionId = SessionId.make("s-link")
const alice = {
  id: ParticipantId.make("dev:alice"),
  login: "alice",
  name: "alice",
} as Participant

/** A signed-in alice, a Runner, an Active Session with a queued prompt, and its mod token. */
const seed = async (hub: TestHub) => {
  await devSignIn(hub, "alice")
  return hub.run(
    Effect.gen(function* () {
      const runner = yield* (yield* RunnerTokens).issue("mac")
      yield* (yield* Sessions).create({
        id: sessionId,
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: "kndl/s-link",
        state: "Active",
        runnerId: runner.runnerId,
        creatorId: alice.id,
        createdAt: Date.now(),
      })
      yield* (yield* PromptQueue).add(sessionId, {
        id: PromptId.make("pr-1"),
        text: "fix the bug",
        sender: alice,
        queuedAt: Date.now(),
      })
      return yield* (yield* ModTokens).issue({ sessionId, runnerId: runner.runnerId })
    }),
  )
}

/** Resolves once `check` holds, polling; fails after two seconds. */
const eventually = async (check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

/** A link to whichever Hub `current` points at, as a Hub restarted behind the same URL is. */
const linkTo = (current: { hub: TestHub }, modToken: string) => {
  const commands: Array<ModCommand> = []
  const statuses: Array<LinkStatus["_tag"]> = []
  const requests: Array<string> = []
  // Cuts the held long poll when the test ends, so its Hub can shut down.
  let cut = new AbortController()
  /** Drops the connections open now, as a Hub going down does. */
  const dropConnections = () => {
    cut.abort()
    cut = new AbortController()
  }
  const fetch: HubFetch = async (url, init) => {
    const path = url.replace("http://hub.test", "")
    requests.push(`${init.method} ${path}`)
    const response = await globalThis.fetch(`${current.hub.url}${path}`, {
      method: init.method,
      headers: init.headers,
      signal: cut.signal,
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    return { status: response.status, text: await response.text() }
  }
  const link = new HubLink({
    hubUrl: "http://hub.test",
    modToken,
    hello: {
      sessionId,
      claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-test",
    },
    fetch,
    // Short, so a restart is noticed at once.
    after: (ms, fn) => void setTimeout(fn, Math.min(ms, 20)),
    onCommand: async (command) => {
      commands.push(command)
    },
    onStatus: (status) => statuses.push(status._tag),
    log: () => undefined,
    flushDelayMs: 10,
  })
  const close = () => {
    link.stop()
    cut.abort()
  }
  return { link, close, dropConnections, commands, statuses, requests }
}

const history = (hub: TestHub) =>
  hub.run(Effect.flatMap(SessionLog, (log) => log.history(sessionId)))

test("links to a real Hub: hello, a delivered prompt, and the Turn's events in the log", async () => {
  const current = { hub: await startHub({ config: { devLogin: true } }) }
  const modToken = await seed(current.hub)
  const { link, close, commands, statuses } = linkTo(current, modToken)
  link.start()
  try {
    // The Hub hands the queued prompt over once the mod has said hello.
    await eventually(() => commands.some((command) => command._tag === "DeliverPrompt"))
    expect(statuses).toContain("Linked")
    const delivered = commands.find((command) => command._tag === "DeliverPrompt")
    expect(delivered).toMatchObject({ promptId: "pr-1", text: "fix the bug", sender: alice })

    const text = promptFromParticipant(alice, "fix the bug")
    link.report({
      _tag: "TurnStarted",
      turnId: "t-1",
      text,
      sender: { _tag: "FromParticipant", participant: alice },
      promptId: "pr-1",
    })
    link.report({ _tag: "TextDelta", turnId: "t-1", text: "On " })
    link.report({ _tag: "TextDelta", turnId: "t-1", text: "it." })
    link.report({
      _tag: "ToolCallStarted",
      turnId: "t-1",
      agentId: "a-1",
      toolCallId: "toolu_1",
      tool: "Bash",
      input: '{"command":"ls"}',
    })
    link.report({
      _tag: "ToolCallEnded",
      turnId: "t-1",
      agentId: "a-1",
      toolCallId: "toolu_1",
      tool: "Bash",
      outcome: "Succeeded",
      output: "README.md",
    })
    link.report({ _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 900 })

    await eventually(async () => (await history(current.hub)).length >= 5)
    expect((await history(current.hub)).map((entry) => entry.event)).toEqual([
      {
        _tag: "TurnStarted",
        turnId: "t-1",
        text,
        sender: { _tag: "FromParticipant", participant: alice },
        promptId: "pr-1",
      },
      { _tag: "TextDelta", turnId: "t-1", text: "On it." },
      {
        _tag: "ToolCallStarted",
        turnId: "t-1",
        agentId: "a-1",
        toolCallId: "toolu_1",
        tool: "Bash",
        input: '{"command":"ls"}',
      },
      {
        _tag: "ToolCallEnded",
        turnId: "t-1",
        agentId: "a-1",
        toolCallId: "toolu_1",
        tool: "Bash",
        outcome: "Succeeded",
        output: "README.md",
      },
      { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 900 },
    ] as never)
    // The Turn took the prompt off the queue.
    const queue = await current.hub.run(
      Effect.flatMap(PromptQueue, (prompts) => prompts.list(sessionId)),
    )
    expect(queue).toEqual([])
  } finally {
    close()
  }
})

test("after a Hub restart, says hello again and takes commands from after=0", async () => {
  const database = databaseAt(join(scratch, "restart.db"))
  const current = { hub: await startHub({ config: { devLogin: true }, database }) }
  const modToken = await seed(current.hub)
  const { link, close, dropConnections, commands, requests } = linkTo(current, modToken)
  link.start()
  try {
    await eventually(() => commands.some((command) => command._tag === "DeliverPrompt"))
    // The first Hub numbered past 0 already (presence, then the prompt); the restarted one
    // starts over.
    await eventually(() => requests.at(-1)?.startsWith("GET /mod/commands?after=2&") ?? false)

    const first = current.hub
    current.hub = await startHub({ config: { devLogin: true }, database })
    dropConnections()
    await first.stop()

    // The new Hub knows the Session and token (same database) but not the mod: 409, then hello.
    await current.hub.run(
      Effect.flatMap(ModOutbox, (outbox) =>
        outbox.enqueue(sessionId, ModCommand.cases.StopTurn.make({ sessionId })),
      ),
    )
    await eventually(() => commands.some((command) => command._tag === "StopTurn"))
    const hellos = requests.filter((request) => request === "POST /mod/hello")
    expect(hellos.length).toBeGreaterThanOrEqual(2)
    const afterHello = requests.slice(requests.lastIndexOf("POST /mod/hello") + 1)
    expect(afterHello[0]).toMatch(/^GET \/mod\/commands\?after=0&/)
  } finally {
    close()
  }
})
