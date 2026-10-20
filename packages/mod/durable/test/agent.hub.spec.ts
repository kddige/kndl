// Cross-boundary contract: the real Web/Runner protocols, Hub relay/log/outbox, durable runtime,
// SQLite, and pi-ai streaming. Only the Runner's sandbox and the paid model are replaced.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import type { Extension } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { ModelCatalog } from "@kndl/hub/src/ModelCatalog.ts"
import { ModOutbox } from "@kndl/hub/src/ModOutbox.ts"
import { PromptQueue } from "@kndl/hub/src/PromptQueue.ts"
import { SessionLog } from "@kndl/hub/src/SessionLog.ts"
import { issueRunnerToken, openRunner, openWeb, stopAll } from "@kndl/hub/src/testChannels.ts"
import type { Connection, Web } from "@kndl/hub/src/testChannels.ts"
import { seedEnvironment, startHub } from "@kndl/hub/src/testSupport.ts"
import {
  ModCommand,
  ModEvents,
  Participant,
  ParticipantId,
  SessionEventLogged,
  SessionId,
  WebToHub,
} from "@kndl/protocol"
import type { ModEvent, ProviderModel, SessionEvent } from "@kndl/protocol"
import { Effect, Layer, Schema } from "effect"
import { startDurableAgent } from "../src/DurableAgent.ts"
import type { DurableAgent } from "../src/DurableAgent.ts"
import { catalogOf } from "../src/Providers.ts"
import { callTool, eventually, holdTool, say } from "./TestAgent.ts"

const alice = { id: "dev:alice", login: "alice", name: "alice" }
const bob = { id: "dev:bob", login: "bob", name: "bob" }
const creatorModels: ReadonlyArray<ProviderModel> = [
  { provider: "openai", id: "gpt-test", label: "Creator's main model", thinkingLevels: [] },
  { provider: "openai", id: "gpt-other", label: "Creator's thread model", thinkingLevels: [] },
]
const bobModels: ReadonlyArray<ProviderModel> = [
  { provider: "xai", id: "grok-test", label: "Bob's unrelated model", thinkingLevels: [] },
]

/** Encode/decode the actual protocol instead of accepting arbitrary command records. */
const send = (web: Connection<Web>, command: typeof WebToHub.Encoded) => {
  Schema.decodeUnknownSync(WebToHub)(command)
  web.send(command)
}

const logged = async <Tag extends SessionEvent["_tag"]>(
  web: Connection<Web>,
  tag: Tag,
  where: (event: Extract<SessionEvent, { _tag: Tag }>) => boolean = () => true,
): Promise<Extract<SessionEvent, { _tag: Tag }>> => {
  const message = await web.take(
    "SessionEventLogged",
    (m) =>
      m.entry.event._tag === tag && where(m.entry.event as Extract<SessionEvent, { _tag: Tag }>),
  )
  // Validate the bytes the browser receives, including ids, usage and optional thread fields.
  return Schema.decodeUnknownSync(SessionEventLogged)(message).entry.event as Extract<
    SessionEvent,
    { _tag: Tag }
  >
}

const messageText = (message: Message | undefined): string => {
  if (message === undefined) return ""
  if (typeof message.content === "string") return message.content
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}
const systemText = (context: TranscriptContext) =>
  context.messages
    .flatMap((message) =>
      message.role === "system"
        ? [messageText(message), ...Object.values(message.sections ?? {}).filter((s) => s !== null)]
        : [],
    )
    .join("\n")

type Reply = (context: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
  } finally {
    await stopAll()
  }
})

/** A Session created on the web, on a real Hub; only the Runner's process launch is ours. */
async function scene(reply: Reply, extensions: ReadonlyArray<Extension> = []) {
  const dir = mkdtempSync(join(tmpdir(), "kndl-durable-real-hub-"))
  let agent: DurableAgent | undefined
  cleanups.push(async () => {
    await agent?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  const hub = await startHub({
    config: { devLogin: true },
    modelCatalog: Layer.succeed(ModelCatalog, {
      modelsFor: (id) => Effect.succeed(id === alice.id ? creatorModels : bobModels),
      signedIn: () => Effect.succeed([]),
    }),
  })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
  const web = await openWeb(hub, "alice")
  const participant = await openWeb(hub, "bob")
  await seedEnvironment(hub, "kddige/kndl", alice.id)
  send(web, {
    _tag: "CreateSession",
    requestId: "create-durable-integration",
    repo: "kddige/kndl",
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    harness: "Pi",
    model: "openai/gpt-test",
  })
  const start = await runner.take("StartSession")
  const sessionId = (await web.take("SessionCreated")).session.id
  const id = SessionId.make(sessionId)
  const requests: Array<{ readonly context: TranscriptContext; readonly model: string }> = []
  const batches: Array<{ readonly messages: ReadonlyArray<ModEvent>; readonly status: number }> = []
  const hellos: Array<number> = []
  const launch = async (launchCommand: typeof start) => {
    const helloCount = hellos.length
    const models = createModels()
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-test", contextWindow: 200_000 }, { id: "gpt-other" }],
    })
    models.setProvider(faux.provider)
    faux.setResponses(
      Array.from(
        { length: 100 },
        () =>
          async (
            context: TranscriptContext,
            _options: unknown,
            _state: unknown,
            model: { provider: string; id: string },
          ) => {
            requests.push({ context, model: `${model.provider}/${model.id}` })
            return reply(context)
          },
      ),
    )
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    agent = await startDurableAgent({
      hubUrl: hub.url,
      modToken: launchCommand.modToken,
      sessionId,
      conversationId: launchCommand.resume,
      model: launchCommand.model,
      cwd: dir,
      storage: await openNodeSqliteStorage(join(dir, "session.sqlite")),
      catalog: async () =>
        catalogOf(
          models,
          () => creatorModels.map((m) => `${m.provider}/${m.id}`),
          async () => false,
        ),
      extensions,
      images: false,
      codemode: false,
      secrets: [launchCommand.modToken],
      settings: { compaction: { keepRecentTokens: 50 } },
      flushDelayMs: 5,
      log: (line) => {
        if (process.env.KNDL_TEST_LOG) console.log(line)
      },
      // Observe admission, but never replace the real Hub HTTP transport or its responses.
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const response = await fetch(input, init)
          if (String(input).endsWith("/mod/events") && typeof init?.body === "string") {
            batches.push({
              messages: Schema.decodeUnknownSync(ModEvents)(JSON.parse(init.body)).messages,
              status: response.status,
            })
          }
          if (String(input).endsWith("/mod/hello")) hellos.push(response.status)
          return response
        },
        { preconnect: fetch.preconnect },
      ),
    })
    await eventually(() => hellos.length > helloCount && hellos.at(-1) === 200)
    return agent
  }
  const first = await launch(start)
  for (const client of [web, participant]) {
    send(client, { _tag: "JoinSession", sessionId })
    await client.take("SessionHistory")
  }
  return {
    hub,
    runner,
    web,
    participant,
    sessionId,
    id,
    requests,
    batches,
    hellos,
    launch,
    conversationId: first.conversationId,
    stop: async () => {
      await agent?.shutdown()
      agent = undefined
    },
    history: () => hub.run(Effect.flatMap(SessionLog, (log) => log.history(id))),
  }
}

test("web participants drive a real durable agent: fork, concurrent Turns, plan/usage and compaction", async () => {
  const hold = holdTool()
  const answer = `The answer at the fork is 42. ${"detail ".repeat(400)}`
  const s = await scene(
    (context) => {
      const system = systemText(context)
      const last = context.messages.findLast((message) => message.role !== "system")
      if (system.includes("summar") && !system.includes("kndl"))
        return say("## Goal\nThe answer is 42; preserve the plan.")
      if (system.includes("This is a thread of the session")) return say("Thread answer: 42.")
      if (last?.role === "toolResult") return say(answer)
      if (messageText(last).includes("long main job")) return callTool("hold", { label: "main" })
      return callTool("update_plan", { steps: [{ text: "Verify 42", status: "in_progress" }] })
    },
    [hold.extension],
  )
  const { web, participant, sessionId } = s
  // Bob has different account models, but joins and drives on the Creator's catalogue.
  expect(
    await s.hub.run(
      Effect.flatMap(ModelCatalog, (catalog) => catalog.modelsFor(ParticipantId.make(bob.id))),
    ),
  ).toEqual(bobModels)
  expect((await participant.take("SessionModels")).models).toEqual(creatorModels)
  send(participant, { _tag: "SendPrompt", sessionId, text: "Plan the initial answer" })
  const anchor = await logged(participant, "TurnStarted")
  expect(anchor).toMatchObject({ sender: { _tag: "FromParticipant", participant: bob } })
  expect(anchor.promptId).toBeDefined()
  expect(await logged(participant, "PlanChanged")).toMatchObject({
    plan: { steps: [{ text: "Verify 42", status: "in_progress" }] },
  })
  expect(
    await logged(participant, "TurnEnded", (event) => event.turnId === anchor.turnId),
  ).toMatchObject({ reason: "stop", usage: { model: "openai/gpt-test" } })
  expect(await logged(participant, "UsageChanged")).toMatchObject({
    usage: { input: expect.any(Number), output: expect.any(Number), cost: 0 },
  })
  expect(await s.hub.run(Effect.flatMap(PromptQueue, (queue) => queue.list(s.id)))).toEqual([])

  send(participant, { _tag: "SendPrompt", sessionId, text: "Run a long main job" })
  const main = await logged(participant, "TurnStarted", (event) => event.turnId !== anchor.turnId)
  await logged(participant, "ToolCallStarted", (event) => event.turnId === main.turnId)
  await hold.firstCall
  send(participant, {
    _tag: "CreateThread",
    sessionId,
    anchorTurnId: anchor.turnId,
    text: "Why 42?",
    model: "openai/gpt-other",
  })
  const { threadId } = await participant.take("ThreadCreated")
  expect(
    await logged(participant, "PlanChanged", (event) => event.threadId === threadId),
  ).toMatchObject({
    plan: { steps: [{ text: "Verify 42", status: "in_progress" }] },
  })
  const thread = await logged(participant, "TurnStarted", (event) => event.threadId === threadId)
  expect(thread).toMatchObject({
    sender: { _tag: "FromParticipant", participant: bob },
    text: "[bob] Why 42?",
  })
  expect(thread.turnId).not.toBe(main.turnId)
  const concurrent = await participant.take(
    "SessionUpdated",
    (message) =>
      message.session.threads?.some((summary) => summary.id === threadId && summary.running) ??
      false,
  )
  expect(concurrent.session.currentTurn).toBe(main.turnId)
  expect(
    await logged(participant, "TextDelta", (event) => event.turnId === thread.turnId),
  ).toMatchObject({ threadId, text: "Thread answer: 42." })
  expect(
    await logged(participant, "TurnEnded", (event) => event.turnId === thread.turnId),
  ).toMatchObject({ threadId, reason: "stop", usage: { model: "openai/gpt-other" } })
  expect(
    await logged(participant, "UsageChanged", (event) => event.threadId === threadId),
  ).toMatchObject({ usage: { cost: 0 } })

  const threadRequest = s.requests.find((request) =>
    systemText(request.context).includes("This is a thread of the session"),
  )
  expect(threadRequest?.model).toBe("openai/gpt-other")
  expect(JSON.stringify(threadRequest?.context.messages)).toContain("The answer at the fork is 42.")
  expect(JSON.stringify(threadRequest?.context.messages)).toContain("Verify 42")
  expect(JSON.stringify(threadRequest?.context.messages)).not.toContain("long main job")
  // A fresh browser gets the Hub's actual current state, not a selected old SessionUpdated.
  const observer = await openWeb(s.hub, "carol")
  expect(observer.sessions.sessions.find((session) => session.id === sessionId)).toMatchObject({
    currentTurn: main.turnId,
    threads: [{ id: threadId, running: false }],
  })
  expect(
    (await s.history()).some(
      ({ event }) => event._tag === "TurnEnded" && event.turnId === main.turnId,
    ),
  ).toBe(false)
  hold.release()
  await logged(participant, "TurnEnded", (event) => event.turnId === main.turnId)

  send(participant, { _tag: "CompactConversation", sessionId, instructions: "Keep the plan" })
  expect(await logged(participant, "CompactionStarted")).toMatchObject({
    reason: "manual",
    by: bob,
  })
  expect(await logged(participant, "CompactionEnded")).toMatchObject({
    outcome: "compacted",
    summary: expect.stringContaining("preserve the plan"),
  })
  const history = await s.history()
  // The same real-runtime events reached both durable Hub storage and the Creator's web client.
  for (const tag of [
    "PlanChanged",
    "UsageChanged",
    "CompactionStarted",
    "CompactionEnded",
  ] as const) {
    const event = await logged(web, tag)
    expect(history.some((entry) => JSON.stringify(entry.event) === JSON.stringify(event))).toBe(
      true,
    )
  }
  expect(s.batches.length).toBeGreaterThan(0)
  expect(s.batches.every((batch) => batch.status === 204)).toBe(true)
  expect(await participant.untaken("CommandFailed")).toEqual([])
}, 30_000)

test("Runner stop/wake resumes SQLite work through the Hub; redelivering its prompt does not run it twice", async () => {
  const hold = holdTool()
  const s = await scene(
    (context) => {
      const last = context.messages.findLast((message) => message.role !== "system")
      return last?.role === "toolResult" ? say("Finished after recovery.") : callTool("hold", {})
    },
    [hold.extension],
  )
  send(s.participant, { _tag: "SendPrompt", sessionId: s.sessionId, text: "Survive a restart" })
  const original = await logged(s.participant, "TurnStarted")
  await logged(s.participant, "ToolCallStarted")
  await hold.firstCall
  await s.stop()
  s.runner.send({ _tag: "SessionStopped", sessionId: s.sessionId, reason: "Exited", exitCode: 1 })
  expect(
    await logged(s.participant, "TurnEnded", (event) => event.turnId === original.turnId),
  ).toMatchObject({ reason: "aborted", errorMessage: "The agent exited with code 1" })
  await s.participant.take("SessionUpdated", (message) => message.session.state === "Asleep")
  hold.release()
  send(s.participant, { _tag: "WakeSession", sessionId: s.sessionId })
  const start = await s.runner.take("StartSession")
  const recovered = await s.launch(start)
  expect(recovered.conversationId).toBe(s.conversationId)
  const resumed = await logged(
    s.participant,
    "TurnStarted",
    (event) => event.sender._tag === "Resumed",
  )
  expect(resumed.turnId).not.toBe(original.turnId)
  expect(
    await logged(s.participant, "TurnEnded", (event) => event.turnId === resumed.turnId),
  ).toMatchObject({ reason: "stop" })
  expect(
    await logged(s.participant, "TextDelta", (event) => event.turnId === resumed.turnId),
  ).toMatchObject({ text: "Finished after recovery." })
  expect(s.hellos).toEqual([200, 200])
  const requestsBeforeRedelivery = s.requests.length
  // Web SendPrompt intentionally mints a fresh id. Requeue the original transport command to
  // simulate at-least-once delivery, using the real outbox and command schema, not a fake mod.
  const promptId = original.promptId
  if (promptId === undefined) throw new Error("The web prompt's Turn must retain its prompt id")
  await s.hub.run(
    Effect.flatMap(ModOutbox, (outbox) =>
      outbox.enqueue(
        s.id,
        ModCommand.cases.DeliverPrompt.make({
          sessionId: s.id,
          promptId,
          text: "Survive a restart",
          sender: Schema.decodeUnknownSync(Participant)(bob),
        }),
      ),
    ),
  )
  await eventually(() =>
    s.batches.find(
      (batch) =>
        batch.status === 204 &&
        batch.messages.some(
          (event) =>
            event._tag === "PromptAlreadySubmitted" && event.promptId === original.promptId,
        ),
    ),
  )
  expect(s.requests).toHaveLength(requestsBeforeRedelivery)
  const starts = (await s.history()).flatMap(({ event }) =>
    event._tag === "TurnStarted" ? [event] : [],
  )
  expect(starts).toHaveLength(2)
  expect(starts.filter((event) => event.sender._tag === "FromParticipant")).toHaveLength(1)
  expect(s.batches.every((batch) => batch.status === 204)).toBe(true)
}, 30_000)
