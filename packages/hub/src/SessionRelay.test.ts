// The Session relay, end to end: a real Hub, a fake Runner and web clients over WebSockets, and
// a fake mod over HTTP, as the real ones will talk to it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import {
  DefaultEnvironmentDraft,
  EnvironmentVersion,
  MaxLastOutputLength,
  type ModCommandsEncoded,
  type ModEventsEncoded,
  Participant,
  ParticipantId,
  ProtocolVersion,
} from "@kndl/protocol"
import { Effect, Exit, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { signInCookie } from "./Auth.ts"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import { databaseAt } from "./Database.ts"
import { Environments } from "./Environments.ts"
import { HubConfig, type HubConfigInput } from "./HubConfig.ts"
import { ModelCatalog } from "./ModelCatalog.ts"
import { SignIns } from "./SignIns.ts"
import {
  Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type Tagged,
  type ToRunner,
  type Web,
} from "./testChannels.ts"
import { appId, appKeyPair, appSlug, botUserId, StandInGitHub } from "./testGitHubApi.ts"
import {
  baseConfig,
  bearer,
  ensureSetupToken,
  seedEnvironment,
  setupTokenOf,
  startHub,
  type TestHub,
  testDatabaseDir,
} from "./testSupport.ts"

afterEach(stopAll)

type Command = ModCommandsEncoded["messages"][number]["message"]
type ModEvent = ModEventsEncoded["messages"][number]

const alice = { id: "dev:alice", login: "alice", name: "alice" }
const bob = { id: "dev:bob", login: "bob", name: "bob" }

/** The fake mod of a Session, speaking HTTP with the token from StartSession. */
class Mod {
  private after = 0

  constructor(
    private readonly hub: TestHub,
    readonly sessionId: string,
    readonly token: string,
  ) {}

  private request(path: string, body?: unknown) {
    return fetch(`${this.hub.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...bearer(this.token), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /** Says hello, with `more` of it, such as that it steers (#195). */
  async hello(more: Record<string, unknown> = {}) {
    const response = await this.request("/mod/hello", {
      _tag: "ModHello",
      protocolVersion: ProtocolVersion,
      sessionId: this.sessionId,
      conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-opus",
      ...more,
    })
    this.after = 0
    return response
  }

  async post(...messages: ReadonlyArray<ModEvent>) {
    const response = await this.request("/mod/events", { messages })
    expect(response.status).toBe(204)
  }

  /** The commands queued since the last poll, waiting up to `waitMs` for one. */
  async poll(waitMs = 0): Promise<Array<Command>> {
    const response = await this.request(`/mod/commands?after=${this.after}&waitMs=${waitMs}`)
    const body = (await response.json()) as ModCommandsEncoded
    this.after = body.messages.at(-1)?.seq ?? this.after
    return body.messages.map((command) => command.message)
  }

  /**
   * The commands tagged `tag` queued since the last poll, waiting up to `waitMs` for the first.
   * Any command ends a poll, and others (a join's PresenceChanged) may be queued before the one
   * awaited, so it polls again until one comes, rather than filtering the first answer to nothing.
   */
  async next<T extends Command["_tag"]>(
    tag: T,
    waitMs = 0,
  ): Promise<Array<Extract<Command, { _tag: T }>>> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const found = (await this.poll(Math.max(0, deadline - Date.now()))).filter(
        (command): command is Extract<Command, { _tag: T }> => command._tag === tag,
      )
      if (found.length > 0 || Date.now() >= deadline) return found
    }
  }

  /** The prompts delivered since the last poll. */
  deliveries(waitMs = 0) {
    return this.next("DeliverPrompt", waitMs)
  }

  /** `GET /mod/history` with the query (ADR 0030). */
  history(query = "") {
    return this.request(`/mod/history${query}`)
  }
}

/** A Hub with an online Runner and alice signed in on the web, who creates a Session. */
async function sessionScene(
  hub?: TestHub,
  options: {
    /** More of the Runner's hello, such as its models (#128). */
    readonly runnerHello?: Record<string, unknown>
    /** More of the CreateSession, such as its model (#128). */
    readonly create?: Record<string, unknown>
  } = {},
) {
  const theHub = hub ?? (await startHub({ config: { devLogin: true } }))
  const runnerToken = (await issueRunnerToken(theHub)).token
  const runner = await openRunner(theHub, runnerToken, [], undefined, true, options.runnerHello)
  const web = await openWeb(theHub, "alice")
  await seedEnvironment(theHub, "kddige/kndl", "dev:alice")
  web.send({
    _tag: "CreateSession",
    requestId: "req-1",
    repo: "kddige/kndl",
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    ...options.create,
  })
  const start = await runner.take("StartSession")
  const created = await web.take("SessionCreated")
  const sessionId = created.session.id
  const mod = new Mod(theHub, sessionId, start.modToken)
  expect((await mod.hello()).status).toBe(200)
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  const started = await web.take(
    "SessionUpdated",
    (m) => m.session.id === sessionId && !m.session.starting,
  )
  return {
    hub: theHub,
    runner,
    runnerToken,
    web,
    start,
    created,
    /** The Session once its Runner said it started. */
    session: started.session,
    sessionId,
    mod,
  }
}

const joinSession = (web: Connection<Web>, sessionId: string, afterSeq?: number) =>
  web.send({ _tag: "JoinSession", sessionId, ...(afterSeq === undefined ? {} : { afterSeq }) })

type Sender = Extract<ModEvent, { _tag: "TurnStarted" }>["sender"]

const turnStarted = (
  turnId: string,
  promptId?: string,
  sender: Sender = { _tag: "FromTerminal" },
): ModEvent => ({
  _tag: "TurnStarted",
  turnId,
  text: "",
  sender,
  ...(promptId === undefined ? {} : { promptId }),
})

/** A Turn started from the terminal with `text`. */
const turnSaying = (turnId: string, text: string): ModEvent => ({
  _tag: "TurnStarted",
  turnId,
  text,
  sender: { _tag: "FromTerminal" },
})

/** The value, failing the test when it is missing. */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  return value as T
}

const turnEnded = (turnId: string, agentId?: string): ModEvent => ({
  _tag: "TurnEnded",
  turnId,
  reason: "stop",
  durationMs: 10,
  ...(agentId === undefined ? {} : { agentId }),
})

type QueueChanged = Extract<Web, { _tag: "PromptQueueChanged" }>

/** A value as redaction masks it. */
const stars = (value: string) => "*".repeat(value.length)

const queueTexts = (message: QueueChanged) => message.queue.map((prompt) => prompt.text)

/** Matches the PromptQueueChanged that shows the queue holding these prompts, in this order. */
const queueIs =
  (...texts: ReadonlyArray<string>) =>
  (message: QueueChanged) =>
    queueTexts(message).join("\n") === texts.join("\n")

describe("CreateSession", () => {
  test("starts the Session on an online Runner, with a mod token for that Session", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const bobWeb = await openWeb(hub, "bob")
    const { start, created, sessionId, web } = await sessionScene(hub)

    expect(start).toEqual({
      _tag: "StartSession",
      sessionId,
      repo: "kddige/kndl",
      baseBranch: "main",
      workBranch: `claude/${sessionId}`,
      modToken: start.modToken,
      environment: expect.any(Object),
      // Its Creator commits in the Sandbox; a dev login, at an address that reaches no one.
      gitIdentity: { name: "alice", email: "alice@dev-login.invalid" },
      // The durable agent, on its Creator's first Model: Claude's, with a Claude credential.
      harness: "Pi",
      model: expect.stringMatching(/^anthropic\//),
    })
    expect(start.environment?.version).toBe(1)
    expect(start.modToken).toStartWith("chm_")
    expect(created).toMatchObject({
      requestId: "req-1",
      session: {
        id: sessionId,
        repo: "kddige/kndl",
        baseBranch: "main",
        workBranch: `claude/${sessionId}`,
        state: "Active",
        creator: alice,
        currentTurn: null,
      },
    })
    // Everyone's Session list learns of it.
    expect((await bobWeb.take("SessionUpdated")).session).toEqual(created.session)
    expect((await web.take("SessionUpdated")).session).toEqual(created.session)

    // The token is this Session's, and no other's.
    const other = new Mod(hub, "another-session", start.modToken)
    expect((await other.hello()).status).toBe(403)
  })

  test("works on a new Work branch, or directly on the branch picked, or on a branch to create (ADR 0023)", async () => {
    const shapes = [
      {
        branch: { _tag: "Existing", name: "dev", newWorkBranch: true },
        branches: (id: string) => ({ baseBranch: "dev", workBranch: `claude/${id}` }),
        why: "Started on mac from dev",
      },
      {
        branch: { _tag: "Existing", name: "dev", newWorkBranch: false },
        branches: () => ({ baseBranch: "dev", workBranch: "dev" }),
        why: "Started on mac on dev",
      },
      {
        branch: { _tag: "Create", name: "feature/health", from: "dev" },
        branches: () => ({ baseBranch: "dev", workBranch: "feature/health" }),
        why: "Started on mac from dev",
      },
    ]
    for (const shape of shapes) {
      const { start, created, sessionId, web } = await sessionScene(undefined, {
        create: { branch: shape.branch },
      })
      expect(start).toMatchObject(shape.branches(sessionId))
      expect(created.session).toMatchObject(shape.branches(sessionId))
      joinSession(web, sessionId)
      const history = await web.take("SessionHistory")
      expect(history.entries.map((entry) => entry.event)).toContainEqual(
        expect.objectContaining({ _tag: "SessionStateChanged", message: shape.why }),
      )
    }
  })

  test("is refused when no Runner is online", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    web.send({
      _tag: "CreateSession",
      requestId: "req-1",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })

    expect(await web.take("CommandFailed")).toMatchObject({
      command: "CreateSession",
      requestId: "req-1",
      message: "No Runner is online.",
    })
  })
})

describe("the event log", () => {
  test("a late joiner gets the whole history, and afterSeq only what came after", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    const first = await web.take("SessionHistory")
    expect(first.entries).toMatchObject([
      { seq: 0, event: { _tag: "SessionStateChanged", state: "Active", by: alice } },
    ])

    await mod.post(
      turnStarted("t-1"),
      { _tag: "TextDelta", turnId: "t-1", text: "Hello" },
      turnEnded("t-1"),
    )
    const live = [
      await web.take("SessionEventLogged"),
      await web.take("SessionEventLogged"),
      await web.take("SessionEventLogged"),
    ]
    expect(live.map((logged) => [logged.entry.seq, logged.entry.event._tag])).toEqual([
      [1, "TurnStarted"],
      [2, "TextDelta"],
      [3, "TurnEnded"],
    ])

    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    const history = await bobWeb.take("SessionHistory")
    expect(history.entries).toEqual([
      defined(first.entries[0]),
      ...live.map((logged) => logged.entry),
    ])

    joinSession(bobWeb, sessionId, 1)
    const since = await bobWeb.take("SessionHistory")
    expect(since.entries.map((entry) => entry.seq)).toEqual([2, 3])
  })
})

describe("presence", () => {
  test("two web clients see each other, and so does the mod", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    expect((await web.take("PresenceChanged")).participants).toEqual([alice])

    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    expect((await bobWeb.take("PresenceChanged")).participants).toEqual([alice, bob])
    expect((await web.take("PresenceChanged")).participants).toEqual([alice, bob])
    const presence = (await mod.poll()).filter((command) => command._tag === "PresenceChanged")
    expect(presence.at(-1)).toEqual({
      _tag: "PresenceChanged",
      sessionId,
      participants: [alice, bob],
    })

    bobWeb.send({ _tag: "LeaveSession", sessionId })
    expect((await web.take("PresenceChanged")).participants).toEqual([alice])

    joinSession(bobWeb, sessionId)
    expect((await web.take("PresenceChanged")).participants).toEqual([alice, bob])
    await bobWeb.close()
    expect((await web.take("PresenceChanged")).participants).toEqual([alice])
    expect(await mod.poll()).toContainEqual({
      _tag: "PresenceChanged",
      sessionId,
      participants: [alice],
    })
  })

  test("a second tab of the same person changes nothing", async () => {
    const { hub, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("PresenceChanged")
    const secondTab = await openWeb(hub, "alice", web.cookie)
    joinSession(secondTab, sessionId)

    expect((await secondTab.take("PresenceChanged")).participants).toEqual([alice])
    expect(await web.untaken("PresenceChanged")).toEqual([])
  })
})

describe("the Prompt queue", () => {
  test("keeps the Creator's prompts in order with their sender, for every joined client, and cancels them", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    // A Turn typed at the terminal is running, so the queue waits.
    await mod.post(turnStarted("t-0"))
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    joinSession(bobWeb, sessionId)

    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    await bobWeb.take("PromptQueueChanged", queueIs("one"))
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const queued = await bobWeb.take("PromptQueueChanged", queueIs("one", "two"))
    expect(queued.queue.map((prompt) => [prompt.text, prompt.sender])).toEqual([
      ["one", alice],
      ["two", alice],
    ])

    web.send({ _tag: "CancelPrompt", sessionId, promptId: defined(queued.queue[0]).id })
    await web.take("PromptQueueChanged", queueIs("two"))
    await bobWeb.take("PromptQueueChanged", queueIs("two"))

    web.send({ _tag: "CancelPrompt", sessionId, promptId: defined(queued.queue[0]).id })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "CancelPrompt", sessionId })
    expect(await mod.deliveries()).toEqual([])
  })

  test("delivers one prompt at a time, the next once the Turn has ended", async () => {
    const { web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const queued = await web.take("PromptQueueChanged", queueIs("one", "two"))
    const [one, two] = queued.queue

    expect(await mod.deliveries(500)).toEqual([
      { _tag: "DeliverPrompt", sessionId, promptId: defined(one).id, text: "one", sender: alice },
    ])

    // Delivered, it can't be cancelled.
    web.send({ _tag: "CancelPrompt", sessionId, promptId: one?.id ?? "" })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "CancelPrompt" })

    // Its Turn starts: it leaves the queue, but the next waits for the Turn to end.
    await mod.post(turnStarted("t-1", one?.id, { _tag: "FromParticipant", participant: alice }))
    await web.take("PromptQueueChanged", queueIs("two"))
    expect(
      (await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")).session,
    ).toMatchObject({ currentTurn: "t-1" })
    await mod.post(turnEnded("t-1", "subagent-1"))
    expect(await mod.deliveries(50)).toEqual([])

    await mod.post(turnEnded("t-1"))
    expect(await mod.deliveries(500)).toEqual([
      { _tag: "DeliverPrompt", sessionId, promptId: defined(two).id, text: "two", sender: alice },
    ])
    expect(await mod.deliveries(50)).toEqual([])
  })

  test("drops a prompt the mod couldn't deliver, tells its sender, and delivers the next", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const [one, two] = (await web.take("PromptQueueChanged", queueIs("one", "two"))).queue
    expect((await mod.deliveries(500)).map((command) => command.promptId)).toEqual([
      defined(one).id,
    ])

    await mod.post({ _tag: "PromptFailed", promptId: one?.id ?? "", message: "no input box" })

    expect(await web.take("CommandFailed")).toMatchObject({ command: "SendPrompt", sessionId })
    await web.take("PromptQueueChanged", queueIs("two"))
    expect((await mod.deliveries(500)).map((command) => command.promptId)).toEqual([
      defined(two).id,
    ])
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
  })

  test("takes a prompt the mod had given Claude Code already out of the queue, and delivers the next (#323)", async () => {
    // As after a Hub restart, which forgets the prompt was delivered, or a TurnStarted lost: the
    // head of the queue is delivered again, and the mod doesn't run it twice.
    const { web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const [one, two] = (await web.take("PromptQueueChanged", queueIs("one", "two"))).queue
    expect((await mod.deliveries(500)).map((command) => command.promptId)).toEqual([
      defined(one).id,
    ])

    await mod.post({ _tag: "PromptAlreadySubmitted", promptId: defined(one).id })

    await web.take("PromptQueueChanged", queueIs("two"))
    expect((await mod.deliveries(500)).map((command) => command.promptId)).toEqual([
      defined(two).id,
    ])
    // Nothing failed: its sender isn't told otherwise.
    expect(await web.untaken("CommandFailed")).toEqual([])
  })
})

/** The prompts sent to join the running Turn since the last poll. */
const steers = (mod: Mod, waitMs = 0) => mod.next("DeliverIntoTurn", waitMs)

describe("steering (#195)", () => {
  test("hands a queued prompt to the running Turn, where it leaves the queue once it joined", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    expect((await mod.hello({ steers: true })).status).toBe(200)
    await mod.post(turnStarted("t-0"))
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    joinSession(bobWeb, sessionId)
    await bobWeb.take("SessionHistory")
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const [one, two] = (await bobWeb.take("PromptQueueChanged", queueIs("one", "two"))).queue

    // Anyone steers, Bob too, who didn't create it (the Pi Durable spike lifts ADR 0026's rule).
    bobWeb.send({ _tag: "SteerPrompt", sessionId, promptId: defined(two).id })
    expect(await steers(mod, 500)).toEqual([
      { _tag: "DeliverIntoTurn", sessionId, promptId: defined(two).id, text: "two", sender: alice },
    ])
    // On its way into the Turn, it can't be cancelled, and is steered once.
    web.send({ _tag: "CancelPrompt", sessionId, promptId: defined(two).id })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "CancelPrompt", sessionId })
    web.send({ _tag: "SteerPrompt", sessionId, promptId: defined(two).id })
    expect(await steers(mod, 50)).toEqual([])

    const steered: ModEvent = {
      _tag: "PromptSteered",
      turnId: "t-0",
      promptId: defined(two).id,
      text: "two",
      sender: alice,
    }
    await mod.post(steered)
    await web.take("PromptQueueChanged", queueIs("one"))
    expect((await bobWeb.take("SessionEventLogged")).entry.event).toEqual(steered)
    const read: ModEvent = { _tag: "SteeredPromptRead", turnId: "t-0", promptId: defined(two).id }
    await mod.post(read)
    expect((await bobWeb.take("SessionEventLogged")).entry.event).toEqual(read)

    // The Turn goes on as it was, and the rest of the queue waits for it to end.
    expect(await mod.deliveries(50)).toEqual([])
    await mod.post(turnEnded("t-0"))
    expect((await mod.deliveries(500)).map((command) => command.promptId)).toEqual([
      defined(one).id,
    ])
  })

  test("is refused without a running Turn, and by a mod from before steering", async () => {
    const { web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    const [one] = (await web.take("PromptQueueChanged", queueIs("one"))).queue
    expect(await mod.deliveries(500)).toHaveLength(1)

    // Idle, the prompt goes next anyway; here it is already delivered.
    web.send({ _tag: "SteerPrompt", sessionId, promptId: defined(one).id })
    expect((await web.take("CommandFailed")).message).toContain("No Turn is running")

    await mod.post(turnStarted("t-1", one?.id, { _tag: "FromParticipant", participant: alice }))
    await web.take("PromptQueueChanged", queueIs())
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const [two] = (await web.take("PromptQueueChanged", queueIs("two"))).queue
    web.send({ _tag: "SteerPrompt", sessionId, promptId: defined(two).id })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "SteerPrompt",
      sessionId,
      message: expect.stringContaining("a mod from before steering"),
    })
    web.send({ _tag: "SteerPrompt", sessionId, promptId: "p-gone" })
    expect((await web.take("CommandFailed")).message).toContain("a mod from before steering")
    expect(await steers(mod, 50)).toEqual([])
  })

  test("a steer that fails leaves the prompt in its place, and tells whoever steered it", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    expect((await mod.hello({ steers: true })).status).toBe(200)
    await mod.post(turnStarted("t-0"))
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    joinSession(bobWeb, sessionId)
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    const [one] = (await bobWeb.take("PromptQueueChanged", queueIs("one", "two"))).queue
    web.send({ _tag: "SteerPrompt", sessionId, promptId: "p-gone" })
    expect((await web.take("CommandFailed")).message).toContain("not in the Prompt queue")

    web.send({ _tag: "SteerPrompt", sessionId, promptId: defined(one).id })
    expect(await steers(mod, 500)).toHaveLength(1)
    // The Turn ends before the mod answers: nothing is delivered until it does.
    await mod.post(turnEnded("t-0"))
    expect(await mod.deliveries(50)).toEqual([])

    await mod.post({
      _tag: "PromptFailed",
      promptId: defined(one).id,
      message: "the Turn ended before it could join",
    })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "SteerPrompt",
      sessionId,
      message: expect.stringContaining("the Turn ended before it could join"),
    })
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
    // Still first in the queue, it is delivered as prompts are.
    expect((await mod.deliveries(500)).map((command) => command.promptId)).toEqual([
      defined(one).id,
    ])
    // Nobody saw it leave the queue.
    expect((await web.untaken("PromptQueueChanged")).map(queueTexts)).not.toContainEqual(["two"])
  })
})

describe("StopTurn", () => {
  test("is logged with who asked, and forwarded to the mod", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    await mod.post(turnStarted("t-1"))
    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    await bobWeb.take("SessionHistory")
    web.send({ _tag: "StopTurn", sessionId })

    expect((await bobWeb.take("SessionEventLogged")).entry.event).toEqual({
      _tag: "TurnStopRequested",
      by: alice,
    })
    expect(await mod.next("StopTurn", 500)).toContainEqual({ _tag: "StopTurn", sessionId })
  })
})

describe("a Runner going offline", () => {
  test("freezes its Sessions, whose prompts wait until it says hello with them again", async () => {
    const { hub, runner, runnerToken, web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await runner.close()

    expect((await web.take("SessionUpdated", (m) => m.session.state === "Frozen")).session.id).toBe(
      sessionId,
    )
    expect(
      (await web.take("RunnerList", (m) => m.runners[0]?.isOnline === false)).runners,
    ).toHaveLength(1)
    expect((await web.take("SessionEventLogged")).entry.event).toMatchObject({
      _tag: "SessionStateChanged",
      state: "Frozen",
    })
    web.send({ _tag: "SendPrompt", sessionId, text: "anyone there?" })
    await web.take("PromptQueueChanged", queueIs("anyone there?"))
    expect(await web.untaken("CommandFailed")).toEqual([])
    expect(await mod.deliveries(50)).toEqual([])

    // Claude Code kept running in tmux, so the Session is Active again, and the prompt goes out.
    await openRunner(hub, runnerToken, [sessionId])
    expect((await web.take("SessionUpdated", (m) => m.session.state === "Active")).session.id).toBe(
      sessionId,
    )
    await web.take("RunnerList", (m) => m.runners[0]?.isOnline === true)
    expect((await mod.deliveries(500)).map((command) => command.text)).toEqual(["anyone there?"])
  })

  test("gives a Session a Runner kept across its restart a new mod token, and no wake (#157)", async () => {
    const { hub, runner, runnerToken, web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "SendPrompt", sessionId, text: "after the restart?" })
    await web.take("PromptQueueChanged", queueIs("after the restart?"))

    // Its mod token went with the old Runner's memory: the Hub only has its hash.
    const back = await openRunner(hub, runnerToken, [sessionId], undefined, true, {
      withoutModToken: [sessionId],
    })
    const reissued = await back.take("ModTokenReissued")
    expect(reissued.sessionId).toBe(sessionId)
    expect(reissued.modToken).not.toBe(mod.token)
    await web.take("SessionUpdated", (m) => m.session.state === "Active")

    // The old token is refused, and the new one gets the prompt that waited.
    expect((await mod.hello()).status).toBe(401)
    const renewed = new Mod(hub, sessionId, reissued.modToken)
    expect((await renewed.hello()).status).toBe(200)
    expect((await renewed.deliveries(500)).map((command) => command.text)).toEqual([
      "after the restart?",
    ])
    expect(await back.untaken("StartSession")).toEqual([])
    expect(await back.untaken("StopSession")).toEqual([])
  })

  test("puts to sleep a Session kept running across an update whose mod speaks an older protocol, waking it on the new mod for the prompt that waited", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "SendPrompt", sessionId, text: "after the update?" })
    await web.take("PromptQueueChanged", queueIs("after the update?"))

    // The Runner was turned away for its protocol version, updated, and restarted under the
    // Session (ADR 0011): its Claude Code runs on, with the mod it started with.
    const back = await openRunner(hub, runnerToken, [sessionId], undefined, true, {
      withoutModToken: [sessionId],
    })
    const { modToken } = await back.take("ModTokenReissued")
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    const old = await fetch(`${hub.url}/mod/hello`, {
      method: "POST",
      headers: { ...bearer(modToken), "content-type": "application/json" },
      body: JSON.stringify({
        _tag: "ModHello",
        protocolVersion: ProtocolVersion - 1,
        sessionId,
        claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
        model: "claude-opus",
      }),
    })
    expect(old.status).toBe(400)

    // That mod can't take the prompt, so the Session sleeps, and the prompt wakes it on the new.
    expect(await back.take("StopSession")).toEqual({
      _tag: "StopSession",
      sessionId,
      reason: "Sleep",
    })
    back.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect(
      (await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event,
    ).toMatchObject({
      message: "Its mod is from before the Hub's update, so it sleeps, to wake on the new one",
    })
    const start = await back.take("StartSession")
    expect(start).toMatchObject({ sessionId, resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f" })
    back.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const renewed = new Mod(hub, sessionId, start.modToken)
    expect((await renewed.hello()).status).toBe(200)
    expect((await renewed.deliveries(500)).map((command) => command.text)).toEqual([
      "after the update?",
    ])
  })

  test("wakes a Session whose Claude Code stopped while it was away, if prompts wait", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "SendPrompt", sessionId, text: "still there?" })
    await web.take("PromptQueueChanged", queueIs("still there?"))

    const back = await openRunner(hub, runnerToken, [])
    expect(await back.take("StartSession")).toMatchObject({
      sessionId,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
  })
})

/** A Hub whose Sessions go Asleep after `sleepAfterMs` idle. */
const hubSleepingAfter = (sleepAfterMs: number) =>
  startHub({ config: { devLogin: true, sleepAfterMs } })

/** Puts the Session to sleep by hand, playing the Runner's part. */
async function asleep(scene: Awaited<ReturnType<typeof sessionScene>>) {
  const { runner, web, sessionId } = scene
  web.send({ _tag: "SleepSession", sessionId })
  expect(await runner.take("StopSession")).toEqual({
    _tag: "StopSession",
    sessionId,
    reason: "Sleep",
  })
  runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
  await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
}

describe("the Session lifecycle", () => {
  test("an idle Session is stopped, and recorded Asleep once its Runner says it stopped", async () => {
    const scene = await sessionScene(await hubSleepingAfter(200))
    const { hub, runner, sessionId } = scene

    expect(await runner.take("StopSession")).toEqual({
      _tag: "StopSession",
      sessionId,
      reason: "Sleep",
    })
    // Still Active until the Runner has stopped it.
    const watcher = await openWeb(hub, "bob")
    expect(watcher.sessions.sessions[0]?.state).toBe("Active")

    runner.send({ _tag: "SandboxStateReport", sessionId, state: "Stopping" })
    runner.send({ _tag: "SandboxStateReport", sessionId, state: "Stopped" })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    await watcher.take("SessionUpdated", (m) => m.session.state === "Asleep")
    joinSession(watcher, sessionId)
    expect((await watcher.take("SessionHistory")).entries.at(-1)?.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      message: "Idle for 200ms",
    })
    // Asked once.
    expect(await runner.untaken("StopSession")).toEqual([])
  })

  test("a Participant present, a Turn running or a prompt waiting keeps it awake", async () => {
    const hub = await hubSleepingAfter(150)
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    const start = await runner.take("StartSession")
    const sessionId = start.sessionId
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    // The mod hasn't said hello, so the prompt waits in the queue.
    web.send({ _tag: "SendPrompt", sessionId, text: "hold on" })
    await web.take("PromptQueueChanged", queueIs("hold on"))
    web.send({ _tag: "LeaveSession", sessionId })
    await Bun.sleep(250)
    expect(await runner.untaken("StopSession")).toEqual([])

    const mod = new Mod(hub, sessionId, start.modToken)
    await mod.hello()
    runner.send({ _tag: "SessionStarted", sessionId })
    const [delivered] = await mod.deliveries(500)
    await mod.post(turnStarted("t-1", delivered?.promptId))
    await Bun.sleep(250)
    expect(await runner.untaken("StopSession")).toEqual([])

    joinSession(web, sessionId)
    await mod.post(turnEnded("t-1"))
    await Bun.sleep(250)
    expect(await runner.untaken("StopSession")).toEqual([])

    web.send({ _tag: "LeaveSession", sessionId })
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
  })

  test("a prompt wakes an Asleep Session, resuming its conversation, and waits for the new mod", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId, mod, start } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await asleep(scene)
    expect((await web.take("SessionEventLogged")).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      by: alice,
      message: "Put to sleep",
    })

    web.send({ _tag: "SendPrompt", sessionId, text: "wake up" })
    const wake = await runner.take("StartSession")
    expect(wake).toEqual({
      _tag: "StartSession",
      sessionId,
      repo: "kddige/kndl",
      baseBranch: "main",
      workBranch: `claude/${sessionId}`,
      modToken: wake.modToken,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      environment: expect.any(Object),
      gitIdentity: { name: "alice", email: "alice@dev-login.invalid" },
      harness: "Pi",
      model: defined(start.model),
    })
    expect(wake.modToken).not.toBe(start.modToken)
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SessionStateChanged"))
        .entry.event,
    ).toEqual({ _tag: "SessionStateChanged", state: "Active", by: alice, message: "Woken on mac" })

    // The old mod's token is gone; the new mod gets the prompt once it has said hello.
    expect((await mod.hello()).status).toBe(401)
    runner.send({ _tag: "SessionStarted", sessionId })
    const woken = new Mod(hub, sessionId, wake.modToken)
    expect(await woken.deliveries(50)).toEqual([])
    expect((await woken.hello()).status).toBe(200)
    expect((await woken.deliveries(500)).map((command) => command.text)).toEqual(["wake up"])
  })

  test("a failed wake leaves the Session Asleep, says why, and keeps its prompts", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await asleep(scene)

    web.send({ _tag: "SendPrompt", sessionId, text: "are you there?" })
    await runner.take("StartSession")
    await web.take("SessionUpdated", (m) => m.session.state === "Active" && !!m.session.starting)
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "the Sandbox did not start" })

    // The start is over too.
    const asleepAgain = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(asleepAgain.session.starting).toBeUndefined()
    expect(
      (
        await web.take(
          "SessionEventLogged",
          (m) =>
            m.entry.event._tag === "SessionStateChanged" &&
            m.entry.event.state === "Asleep" &&
            m.entry.event.by === undefined,
        )
      ).entry.event,
    ).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      message: "The agent could not start on mac: the Sandbox did not start",
    })
    // Not retried on its own, but the prompt stays queued for the next wake.
    expect(await runner.untaken("StartSession")).toEqual([])
    web.send({ _tag: "WakeSession", sessionId })
    expect(await runner.take("StartSession")).toMatchObject({
      sessionId,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    // Joining again sends the queue afresh: the prompt is still there.
    const bobWeb = await openWeb(scene.hub, "bob")
    joinSession(bobWeb, sessionId)
    expect(queueTexts(await bobWeb.take("PromptQueueChanged"))).toEqual(["are you there?"])
  })

  test("a prompt sent while the Session goes to sleep wakes it right after", async () => {
    const { runner, web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    web.send({ _tag: "SleepSession", sessionId })
    await runner.take("StopSession")
    web.send({ _tag: "SendPrompt", sessionId, text: "one more thing" })
    await web.take("PromptQueueChanged", queueIs("one more thing"))
    expect(await mod.deliveries(50)).toEqual([])

    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested" })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(await runner.take("StartSession")).toMatchObject({
      sessionId,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
  })

  test("a stored conversation id that isn't a plain name wakes the Session in a new conversation", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await asleep(scene)
    // As a mod could have said before only plain names decoded.
    await hub.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE session_conversations SET conversation_id = ${"../../.claude/.credentials"} WHERE session_id = ${sessionId}`,
      ),
    )

    web.send({ _tag: "WakeSession", sessionId })
    expect(await runner.take("StartSession")).not.toHaveProperty("resume")
    expect(
      (
        await web.take(
          "SessionEventLogged",
          (m) => m.entry.event._tag === "SessionStateChanged" && m.entry.event.state === "Active",
        )
      ).entry.event,
    ).toMatchObject({
      message: "Woken on mac, with a new conversation: the agent's last one is unknown",
    })
  })

  test("Sleep now is refused while a Turn runs or prompts wait, and for a Session not Active", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId, mod } = scene
    await mod.post(turnStarted("t-1"))
    web.send({ _tag: "SleepSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "SleepSession",
      sessionId,
      message: "A Turn is running: stop it first.",
    })
    web.send({ _tag: "SendPrompt", sessionId, text: "next" })
    await mod.post(turnEnded("t-1"))
    web.send({ _tag: "SleepSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "SleepSession" })
    expect(await runner.untaken("StopSession")).toEqual([])

    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "SleepSession", sessionId })
    expect((await web.take("CommandFailed")).message).toContain("this one is Frozen")
    web.send({ _tag: "WakeSession", sessionId })
    expect((await web.take("CommandFailed")).message).toContain("Runner is offline")
  })

  test("Restart sleeps an Active Session and wakes it on the Environment's latest version", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId, start } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    expect(start.environment?.version).toBe(1)
    await hub.run(
      Effect.flatMap(Environments, (environments) =>
        environments.apply(
          "kddige/kndl",
          EnvironmentVersion.make(1),
          { ...DefaultEnvironmentDraft, resources: { cpus: 3, memoryMib: 4096 } },
          ParticipantId.make("dev:alice"),
          1,
        ),
      ),
    )

    web.send({ _tag: "RestartSession", sessionId })
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
    // Asking again while it restarts is refused.
    web.send({ _tag: "RestartSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "RestartSession",
      message: "The Session is already restarting.",
    })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    const woken = await runner.take("StartSession")
    expect(woken).toMatchObject({ sessionId, resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f" })
    expect(woken.environment?.version).toBe(2)
    expect(await runner.untaken("StopSession")).toEqual([])
    const changes = [
      await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SessionStateChanged"),
      await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SessionStateChanged"),
    ].map((m) => m.entry.event)
    expect(changes).toEqual([
      {
        _tag: "SessionStateChanged",
        state: "Asleep",
        by: alice,
        message: "Restarting for the Environment's latest version",
      },
      { _tag: "SessionStateChanged", state: "Active", by: alice, message: "Woken on mac" },
    ])

    // An Asleep Session is just woken.
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 2 })
    await asleep(scene)
    web.send({ _tag: "RestartSession", sessionId })
    expect(await runner.take("StartSession")).toMatchObject({ sessionId })
  })

  test("Restart is refused while a Turn runs, and for a Session Frozen or archived", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId, mod } = scene
    await mod.post(turnStarted("t-1"))
    web.send({ _tag: "RestartSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "RestartSession",
      sessionId,
      message: "A Turn is running: stop it first, then restart.",
    })
    expect(await runner.untaken("StopSession")).toEqual([])

    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "RestartSession", sessionId })
    expect((await web.take("CommandFailed")).message).toContain("Frozen")
    web.send({ _tag: "ArchiveSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Archived")
    web.send({ _tag: "RestartSession", sessionId })
    expect((await web.take("CommandFailed")).message).toBe("The Session is archived.")
  })

  test("the summary says starting from StartSession until SessionStarted, on the version sent", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    const start = await runner.take("StartSession")
    const { sessionId } = start
    const created = (await web.take("SessionCreated")).session
    expect(created.state).toBe("Active")
    // Not started on any version yet: the version it is being started on says what is coming.
    expect(created.environment).toEqual({ version: null, latestVersion: 1 })
    expect(created.starting).toEqual({ since: expect.any(Number), environmentVersion: 1 })
    expect((await openWeb(hub, "bob")).sessions.sessions[0]?.starting).toEqual(created.starting)

    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const started = await web.take("SessionUpdated", (m) => m.session.starting === undefined)
    expect(started.session.environment).toEqual({ version: 1, latestVersion: 1 })
  })

  test("Restart and Sleep now are refused while the Session is starting, and it isn't idle", async () => {
    const hub = await hubSleepingAfter(100)
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    const { sessionId } = await runner.take("StartSession")

    web.send({ _tag: "RestartSession", sessionId })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "RestartSession",
      sessionId,
      message: "The Session is still starting; restart it once it has started.",
    })
    web.send({ _tag: "SleepSession", sessionId })
    expect((await web.take("CommandFailed")).message).toBe(
      "The Session is still starting; put it to sleep once it has started.",
    )
    // Building its Environment can take minutes: it isn't put to sleep meanwhile.
    await Bun.sleep(300)
    expect(await runner.untaken("StopSession")).toEqual([])
    expect(await runner.untaken("StartSession")).toEqual([])

    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
  })

  test("a restart shows from the RestartSession until the Session has started again", async () => {
    const { runner, web, sessionId } = await sessionScene()
    web.send({ _tag: "RestartSession", sessionId })
    await runner.take("StopSession")
    const asked = await web.take("SessionUpdated", (m) => m.session.restarting !== undefined)
    expect(asked.session).toMatchObject({
      state: "Active",
      restarting: { by: alice, since: expect.any(Number) },
    })
    expect(asked.session.starting).toBeUndefined()

    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.state === "Asleep")).session.restarting,
    ).toEqual(asked.session.restarting)
    await runner.take("StartSession")
    // Earlier summaries of its first start are still untaken: this one is starting again.
    const starting = await web.take(
      "SessionUpdated",
      (m) => m.session.starting !== undefined && m.session.restarting !== undefined,
    )
    expect(starting.session.state).toBe("Active")
    expect(starting.session.restarting).toEqual(asked.session.restarting)

    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const back = await web.take("SessionUpdated", (m) => m.session.starting === undefined)
    expect(back.session.restarting).toBeUndefined()
  })

  test("restarting an Asleep Session shows until it has started", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId } = scene
    await asleep(scene)
    web.send({ _tag: "RestartSession", sessionId })
    await runner.take("StartSession")
    const woken = await web.take(
      "SessionUpdated",
      (m) => m.session.starting !== undefined && m.session.restarting !== undefined,
    )
    expect(woken.session).toMatchObject({ state: "Active", restarting: { by: alice } })
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "no Docker" })
    const failed = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(failed.session.restarting).toBeUndefined()
  })

  test("HUB_SLEEP_AFTER_MS must be above 0", async () => {
    const result = await Effect.runPromiseExit(HubConfig.make({ ...baseConfig, sleepAfterMs: 0 }))
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("Runner reports", () => {
  test("a Session whose Claude Code exits goes Asleep, and logs why", async () => {
    const { runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })

    expect((await web.take("SessionEventLogged")).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      message: "The agent exited with code 1",
    })
    runner.send({ _tag: "SessionStarted", sessionId })
    expect((await web.take("SessionUpdated", (m) => m.session.state === "Active")).session.id).toBe(
      sessionId,
    )
  })

  test("keeps what Claude Code printed before it exited, until it starts again (#105)", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    const output = "error: The current working directory was deleted"
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1, output })

    const slept = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(slept.session.lastOutput).toBe(output)
    // Kept on the Session: a web client connecting later sees it too.
    const later = await openWeb(hub, "alice")
    expect(later.sessions.sessions.find((s) => s.id === sessionId)?.lastOutput).toBe(output)

    web.send({ _tag: "WakeSession", sessionId })
    await runner.take("StartSession")
    runner.send({ _tag: "SessionStarted", sessionId })
    const active = await web.take("SessionUpdated", (m) => m.session.state === "Active")
    expect(active.session.lastOutput).toBeUndefined()
    // Stopped on request, there is nothing of it to keep.
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    const stopped = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(stopped.session.lastOutput).toBeUndefined()
  })

  test("a SessionStopped longer than the cap keeps its end (#105)", async () => {
    const { runner, web, sessionId } = await sessionScene()
    const output = `${"a".repeat(MaxLastOutputLength)}\nthe end`
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1, output })

    const slept = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(slept.session.lastOutput).toHaveLength(MaxLastOutputLength)
    expect(slept.session.lastOutput?.endsWith("\nthe end")).toBe(true)
  })

  test("keeps an Active Session's Open ports with it, until it sleeps (#175)", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    const ports = [
      { port: 3000, addresses: ["0.0.0.0", "::"], process: "node server" },
      { port: 5432, addresses: ["0.0.0.0"], process: "docker-proxy" },
    ]
    runner.send({ _tag: "SessionPorts", sessionId, ports })

    const listed = await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
    expect(listed.session.openPorts).toEqual(ports)
    // Kept on the Session: a web client connecting later sees it too.
    const later = await openWeb(hub, "alice")
    expect(later.sessions.sessions.find((s) => s.id === sessionId)?.openPorts).toEqual(ports)
    // The same list again changes nothing.
    runner.send({ _tag: "SessionPorts", sessionId, ports })
    runner.send({ _tag: "SandboxNote", sessionId, message: "after the ports" })
    await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SandboxNoted")
    expect((await web.untaken("SessionUpdated")).filter((m) => m.session.openPorts)).toEqual([])

    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    const slept = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(slept.session.openPorts).toBeUndefined()
    // A list that raced the stop is dropped.
    runner.send({ _tag: "SessionPorts", sessionId, ports })
    runner.send({ _tag: "SandboxNote", sessionId, message: "after the stop" })
    await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SandboxNoted")
    expect((await web.untaken("SessionUpdated")).filter((m) => m.session.openPorts)).toEqual([])
    const after = await openWeb(hub, "alice")
    expect(after.sessions.sessions.find((s) => s.id === sessionId)?.openPorts).toBeUndefined()
  })

  test("drops a Session's Open ports when they close, and when its Runner goes offline (#175)", async () => {
    const { runner, web, sessionId } = await sessionScene()
    const ports = [{ port: 8080, addresses: ["::1"], process: "python3 -m" }]
    runner.send({ _tag: "SessionPorts", sessionId, ports })
    await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
    runner.send({ _tag: "SessionPorts", sessionId, ports: [] })
    const closed = await web.take("SessionUpdated")
    expect(closed.session.openPorts).toBeUndefined()

    runner.send({ _tag: "SessionPorts", sessionId, ports })
    await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
    await runner.close()
    const frozen = await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    expect(frozen.session.openPorts).toBeUndefined()
  })

  test("a Runner can't report on another Runner's Session", async () => {
    const { hub, web, sessionId } = await sessionScene()
    const other = await openRunner(hub, (await issueRunnerToken(hub, "linux")).token)
    other.send({ _tag: "SessionStopped", sessionId, reason: "Exited" })

    expect(await web.untaken("SessionUpdated")).toEqual([
      expect.objectContaining({ session: expect.objectContaining({ state: "Active" }) }),
    ])
  })
})

/** A Hub whose Archived Sessions are purged `archiveRetentionMs` after they were archived. */
const hubRetainingFor = (archiveRetentionMs: number) =>
  startHub({ config: { devLogin: true, archiveRetentionMs } })

const thirtyDays = 30 * 24 * 60 * 60 * 1000

/** Archives the Session from `web`, and plays the Runner stopping it for good. */
async function archived(scene: Awaited<ReturnType<typeof sessionScene>>, web = scene.web) {
  const { runner, sessionId } = scene
  web.send({ _tag: "ArchiveSession", sessionId })
  expect(await runner.take("StopSession")).toEqual({
    _tag: "StopSession",
    sessionId,
    reason: "Archive",
  })
  const update = await web.take("SessionUpdated", (m) => m.session.state === "Archived")
  runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
  return update.session
}

const stateChanged = (state: string) => (m: Extract<Web, { _tag: "SessionEventLogged" }>) =>
  m.entry.event._tag === "SessionStateChanged" && m.entry.event.state === state

describe("archive, restore and purge", () => {
  test("its Creator can delete a Session: it is archived at once, and its Runner stops it for good", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId, mod } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "OpenTerminal", sessionId })
    await runner.take("RequestTerminalSnapshot")

    web.send({ _tag: "ArchiveSession", sessionId })
    expect(await runner.take("StopSession")).toEqual({
      _tag: "StopSession",
      sessionId,
      reason: "Archive",
    })
    const session = (await web.take("SessionUpdated", (m) => m.session.state === "Archived"))
      .session
    const at = defined(session.archived).at
    expect(session.archived).toEqual({ by: alice, at, purgeAt: at + thirtyDays })
    expect((await web.take("SessionEventLogged", stateChanged("Archived"))).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Archived",
      by: alice,
    })

    // Its mod is cut off, and its terminal closed.
    expect((await mod.hello()).status).toBe(401)
    runner.send({
      _tag: "TerminalFrame",
      sessionId,
      kind: "Output",
      data: "bye",
      size: { cols: 80, rows: 24 },
    })
    expect(await web.untaken("TerminalFrame")).toEqual([])

    runner.send({ _tag: "SessionStarted", sessionId })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })

    // No prompts, terminal or wake, and it is archived once.
    web.send({ _tag: "SendPrompt", sessionId, text: "hello?" })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "SendPrompt",
      sessionId,
      message: "The Session is archived: restore it to send prompts.",
    })
    web.send({ _tag: "OpenTerminal", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "OpenTerminal",
      message: "The Session is archived: it has no terminal to open.",
    })
    web.send({ _tag: "WakeSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "WakeSession" })
    web.send({ _tag: "ArchiveSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "ArchiveSession",
      message: "The Session is already archived.",
    })
    expect(await runner.untaken("StartSession")).toEqual([])
    expect(await runner.untaken("RequestTerminalSnapshot")).toEqual([])

    // Still Archived, and listed so with who archived it, for the Archived screen.
    const later = await openWeb(hub, "carol")
    expect(later.sessions.sessions).toEqual([
      expect.objectContaining({ id: sessionId, state: "Archived", archived: session.archived }),
    ])
  })

  test("restoring brings it back Asleep, and the next prompt wakes it", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await archived(scene)

    web.send({ _tag: "RestoreSession", sessionId })
    const restored = (await web.take("SessionUpdated", (m) => m.session.state === "Asleep")).session
    expect(restored.archived).toBeUndefined()
    expect((await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      by: alice,
      message: "Restored from the archive",
    })
    expect(await runner.untaken("StartSession")).toEqual([])
    web.send({ _tag: "RestoreSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "RestoreSession",
      message: "The Session is not archived.",
    })

    // Woken on its kept Workspace, resuming its conversation; the Runner gives it a new Sandbox.
    web.send({ _tag: "SendPrompt", sessionId, text: "back again" })
    expect(await runner.take("StartSession")).toMatchObject({
      sessionId,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
  })

  test("an undo before the Runner has stopped it wakes it once stopped, if prompts wait", async () => {
    const { runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "ArchiveSession", sessionId })
    web.send({ _tag: "RestoreSession", sessionId })
    await runner.take("StopSession", (m) => m.reason === "Archive")
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    web.send({ _tag: "SendPrompt", sessionId, text: "never mind" })
    await web.take("PromptQueueChanged", queueIs("never mind"))
    expect(await runner.untaken("StartSession")).toEqual([])

    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect(await runner.take("StartSession")).toMatchObject({
      sessionId,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
  })

  test("a Runner offline when its Session is archived stops it when it is back", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "ArchiveSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Archived")

    const back = await openRunner(hub, runnerToken, [sessionId])
    expect(await back.take("StopSession")).toMatchObject({ sessionId, reason: "Archive" })
    expect(await web.untaken("SessionUpdated")).toEqual([])
    back.send({ _tag: "SessionStopped", sessionId, reason: "Requested" })
    await Bun.sleep(100)
    await back.close()

    // Stopped once is enough.
    const again = await openRunner(hub, runnerToken, [])
    expect(await again.untaken("StopSession")).toEqual([])
  })

  test("a Session restored while its Runner is offline is Frozen until the Runner is back", async () => {
    const scene = await sessionScene()
    const { hub, runnerToken, web, sessionId } = scene
    await archived(scene)
    await Bun.sleep(100)
    await scene.runner.close()
    web.send({ _tag: "RestoreSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")

    await openRunner(hub, runnerToken, [])
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
  })

  test("is purged once its retention is over: its rows go, and its Runner deletes the rest", async () => {
    const scene = await sessionScene(await hubRetainingFor(300))
    const { hub, runner, web, sessionId } = scene
    await seedEnvironment(hub, "kddige/other", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "req-2",
      repo: "kddige/other",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    const kept = (await web.take("SessionCreated")).session
    await runner.take("StartSession")
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    const session = await archived(scene)
    expect(defined(session.archived).purgeAt - defined(session.archived).at).toBe(300)

    expect(await web.take("SessionRemoved")).toEqual({ _tag: "SessionRemoved", sessionId })
    expect(await runner.take("PurgeSession")).toEqual({ _tag: "PurgeSession", sessionId })
    // Gone from the Hub: history, queue and all.
    web.send({ _tag: "RestoreSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({ message: "There is no such Session." })
    joinSession(web, sessionId)
    expect(await web.take("CommandFailed")).toMatchObject({ command: "JoinSession" })
    const later = await openWeb(hub, "bob")
    expect(later.sessions.sessions.map((s) => s.id)).toEqual([kept.id])
    expect(await web.untaken("SessionRemoved")).toEqual([])

    // Once the Runner says it is done, it isn't asked again.
    runner.send({ _tag: "SessionPurged", sessionId })
    await Bun.sleep(100)
    await runner.close()
    const back = await openRunner(hub, scene.runnerToken, [kept.id])
    expect(await back.untaken("PurgeSession")).toEqual([])
  })

  test("a purge waits for an offline Runner, and only that Runner can settle it", async () => {
    const scene = await sessionScene(await hubRetainingFor(300))
    const { hub, runner, runnerToken, web, sessionId } = scene
    await archived(scene)
    await Bun.sleep(100)
    await runner.close()
    await web.take("SessionRemoved")

    // Another Runner can't say it purged this one's Session.
    const other = await openRunner(hub, (await issueRunnerToken(hub, "linux")).token)
    other.send({ _tag: "SessionPurged", sessionId })
    await Bun.sleep(100)

    const back = await openRunner(hub, runnerToken, [])
    expect(await back.take("PurgeSession")).toEqual({ _tag: "PurgeSession", sessionId })
    // Not done yet: asked again on the next connection.
    await back.close()
    const again = await openRunner(hub, runnerToken, [])
    expect(await again.take("PurgeSession")).toEqual({ _tag: "PurgeSession", sessionId })
    again.send({ _tag: "SessionPurged", sessionId })
    await Bun.sleep(100)
    await again.close()
    const last = await openRunner(hub, runnerToken, [])
    expect(await last.untaken("PurgeSession")).toEqual([])
  })

  test("a restored Session isn't purged, and archiving it again starts its retention afresh", async () => {
    const scene = await sessionScene(await hubRetainingFor(200))
    const { runner, web, sessionId } = scene
    await archived(scene)
    web.send({ _tag: "RestoreSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    await Bun.sleep(300)
    expect(await web.untaken("SessionRemoved")).toEqual([])
    expect(await runner.untaken("PurgeSession")).toEqual([])

    await archived(scene)
    await web.take("SessionRemoved")
  })

  test("any Member who can see an Archived Session can purge it now, not just its Creator (#351)", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId } = scene
    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    await bobWeb.take("SessionHistory")
    await archived(scene)

    // Its retention is 30 days, but bob purges it now: purging isn't driving (ADR 0027).
    bobWeb.send({ _tag: "PurgeArchivedSession", requestId: "r-purge", sessionId })
    expect(await bobWeb.take("ArchivedSessionPurged")).toEqual({
      _tag: "ArchivedSessionPurged",
      requestId: "r-purge",
      sessionId,
      runnerOnline: true,
    })
    expect(await runner.take("PurgeSession")).toEqual({ _tag: "PurgeSession", sessionId })
    for (const client of [web, bobWeb]) {
      expect(await client.take("SessionRemoved")).toEqual({ _tag: "SessionRemoved", sessionId })
    }

    // Gone from the Hub, so it can't be restored, or purged again.
    web.send({ _tag: "RestoreSession", sessionId })
    expect(await web.take("CommandFailed")).toMatchObject({ message: "There is no such Session." })
    bobWeb.send({ _tag: "PurgeArchivedSession", requestId: "r-again", sessionId })
    expect(await bobWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "PurgeArchivedSession",
      sessionId,
      requestId: "r-again",
      message: "There is no such Session.",
    })
    expect((await openWeb(hub, "carol")).sessions.sessions).toEqual([])

    // Once the Runner says it is done, it isn't asked again.
    runner.send({ _tag: "SessionPurged", sessionId })
    await Bun.sleep(100)
    await runner.close()
    const back = await openRunner(hub, scene.runnerToken, [])
    expect(await back.untaken("PurgeSession")).toEqual([])
  })

  test("refuses to purge a Session that isn't Archived", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")
    for (const client of [web, bobWeb]) {
      client.send({ _tag: "PurgeArchivedSession", requestId: "r-purge", sessionId })
      expect(await client.take("CommandFailed")).toEqual({
        _tag: "CommandFailed",
        command: "PurgeArchivedSession",
        sessionId,
        requestId: "r-purge",
        message: "Only an Archived Session can be purged: delete it first.",
      })
    }
    expect(await runner.untaken("PurgeSession")).toEqual([])
    expect(await web.untaken("SessionRemoved")).toEqual([])
    expect((await openWeb(hub, "carol")).sessions.sessions).toEqual([
      expect.objectContaining({ id: sessionId, state: "Active" }),
    ])
  })

  test("a purge with its Runner offline says so, and the Runner frees the disk when it is back", async () => {
    const scene = await sessionScene()
    const { hub, runner, runnerToken, web, sessionId } = scene
    await archived(scene)
    await Bun.sleep(100)
    await runner.close()

    web.send({ _tag: "PurgeArchivedSession", requestId: "r-purge", sessionId })
    expect(await web.take("ArchivedSessionPurged")).toEqual({
      _tag: "ArchivedSessionPurged",
      requestId: "r-purge",
      sessionId,
      runnerOnline: false,
    })
    await web.take("SessionRemoved")

    const back = await openRunner(hub, runnerToken, [])
    expect(await back.take("PurgeSession")).toEqual({ _tag: "PurgeSession", sessionId })
    back.send({ _tag: "SessionPurged", sessionId })
    await Bun.sleep(100)
    await back.close()
    const again = await openRunner(hub, runnerToken, [])
    expect(await again.untaken("PurgeSession")).toEqual([])
  })

  test("asks the Runner how much disk an Archived Session takes, and keeps the answer for a minute (#352)", async () => {
    const scene = await sessionScene(undefined, { runnerHello: { measuresDisk: true } })
    const { hub, runner, web, sessionId } = scene
    await archived(scene)
    const bobWeb = await openWeb(hub, "bob")

    // Nothing is measured until somebody asks.
    expect(await runner.untaken("MeasureSessionDisks")).toEqual([])

    bobWeb.send({
      _tag: "GetSessionDiskUsage",
      requestId: "r-size",
      sessionIds: [sessionId, "no-such-session"],
    })
    const ask = await runner.take("MeasureSessionDisks")
    expect(ask.sessionIds).toEqual([sessionId])
    runner.send({
      _tag: "SessionDisksMeasured",
      requestId: ask.requestId,
      sizes: [{ sessionId, bytes: 1_572_864 }],
    })
    expect(await bobWeb.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-size",
      // Asked order; an unknown Session has no size.
      sizes: [{ sessionId, bytes: 1_572_864 }, { sessionId: "no-such-session" }],
    })

    // Alice opens the list too: the Runner isn't asked again.
    web.send({ _tag: "GetSessionDiskUsage", requestId: "r-again", sessionIds: [sessionId] })
    expect(await web.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-again",
      sizes: [{ sessionId, bytes: 1_572_864 }],
    })
    expect(await runner.untaken("MeasureSessionDisks")).toEqual([])
  })

  test("a size the Runner couldn't measure is unknown, and asked again next time (#352)", async () => {
    const scene = await sessionScene(undefined, { runnerHello: { measuresDisk: true } })
    const { runner, web, sessionId } = scene
    await archived(scene)

    web.send({ _tag: "GetSessionDiskUsage", requestId: "r-1", sessionIds: [sessionId] })
    const ask = await runner.take("MeasureSessionDisks")
    runner.send({ _tag: "SessionDisksMeasured", requestId: ask.requestId, sizes: [{ sessionId }] })
    expect(await web.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-1",
      sizes: [{ sessionId }],
    })

    web.send({ _tag: "GetSessionDiskUsage", requestId: "r-2", sessionIds: [sessionId] })
    const again = await runner.take("MeasureSessionDisks")
    expect(again.requestId).not.toBe(ask.requestId)
    runner.send({
      _tag: "SessionDisksMeasured",
      requestId: again.requestId,
      sizes: [{ sessionId, bytes: 7 }],
    })
    expect(await web.take("SessionDiskUsage")).toMatchObject({ sizes: [{ sessionId, bytes: 7 }] })
  })

  test("the size is unknown while its Runner is offline, or too old to measure, and the Runner isn't asked (#352)", async () => {
    const old = await sessionScene()
    await archived(old)
    old.web.send({ _tag: "GetSessionDiskUsage", requestId: "r-old", sessionIds: [old.sessionId] })
    expect(await old.web.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-old",
      sizes: [{ sessionId: old.sessionId }],
    })
    expect(await old.runner.untaken("MeasureSessionDisks")).toEqual([])

    const scene = await sessionScene(undefined, { runnerHello: { measuresDisk: true } })
    const { runner, web, sessionId } = scene
    await archived(scene)
    await Bun.sleep(100)
    await runner.close()
    web.send({ _tag: "GetSessionDiskUsage", requestId: "r-off", sessionIds: [sessionId] })
    expect(await web.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-off",
      sizes: [{ sessionId }],
    })
  })

  test("a Runner that goes offline mid-measure leaves the size unknown (#352)", async () => {
    const scene = await sessionScene(undefined, { runnerHello: { measuresDisk: true } })
    const { runner, web, sessionId } = scene
    await archived(scene)
    await Bun.sleep(100)

    web.send({ _tag: "GetSessionDiskUsage", requestId: "r-1", sessionIds: [sessionId] })
    await runner.take("MeasureSessionDisks")
    await runner.close()
    expect(await web.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-1",
      sizes: [{ sessionId }],
    })
  })

  test("only an Archived Session is measured (#352)", async () => {
    const { runner, web, sessionId } = await sessionScene(undefined, {
      runnerHello: { measuresDisk: true },
    })
    web.send({ _tag: "GetSessionDiskUsage", requestId: "r-live", sessionIds: [sessionId] })
    expect(await web.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-live",
      sizes: [{ sessionId }],
    })
    expect(await runner.untaken("MeasureSessionDisks")).toEqual([])
  })

  test("refuses to measure past the bound on Sessions per request (#352)", async () => {
    const { web } = await sessionScene()
    web.send({
      _tag: "GetSessionDiskUsage",
      requestId: "r-many",
      sessionIds: Array.from({ length: 501 }, (_, i) => `s-${i}`),
    })
    expect(await web.untaken("SessionDiskUsage")).toEqual([])
  })

  test("refuses unknown Sessions", async () => {
    const { web } = await sessionScene()
    web.send({ _tag: "PurgeArchivedSession", requestId: "r-purge", sessionId: "nope" })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "PurgeArchivedSession",
      sessionId: "nope",
      requestId: "r-purge",
      message: "There is no such Session.",
    })
    web.send({ _tag: "ArchiveSession", sessionId: "nope" })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "ArchiveSession",
      message: "There is no such Session.",
    })
    web.send({ _tag: "RestoreSession", sessionId: "nope" })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "RestoreSession" })
  })

  test("HUB_ARCHIVE_RETENTION_MS must be above 0", async () => {
    const result = await Effect.runPromiseExit(
      HubConfig.make({ ...baseConfig, archiveRetentionMs: 0 }),
    )
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("Session names", () => {
  test("its Creator can rename a Session, and every client sees it live", async () => {
    const { hub, web, sessionId, session } = await sessionScene()
    expect(session.name).toBeUndefined()
    const bobWeb = await openWeb(hub, "bob")

    // The name is trimmed.
    web.send({ _tag: "RenameSession", sessionId, name: "  Health check " })
    for (const client of [web, bobWeb]) {
      const renamed = await client.take("SessionUpdated", (m) => m.session.name !== undefined)
      expect(renamed.session).toEqual({ ...session, name: "Health check" })
    }
    const later = await openWeb(hub, "carol")
    expect(later.sessions.sessions).toEqual([{ ...session, name: "Health check" }])

    // The same name again changes nothing.
    web.send({ _tag: "RenameSession", sessionId, name: "Health check" })
    expect(await bobWeb.untaken("SessionUpdated")).toEqual([])

    // Clearing it goes back to the Work branch.
    web.send({ _tag: "RenameSession", sessionId, name: "   " })
    for (const client of [bobWeb, later]) {
      expect((await client.take("SessionUpdated")).session).toEqual(session)
    }
    expect((await web.untaken("SessionUpdated")).at(-1)?.session).toEqual(session)
  })

  test("a name over the maximum length is refused, and the name stays", async () => {
    const { hub, web, sessionId } = await sessionScene()
    web.send({ _tag: "RenameSession", sessionId, name: "Health check" })
    await web.take("SessionUpdated", (m) => m.session.name === "Health check")

    web.send({ _tag: "RenameSession", sessionId, name: "x".repeat(81) })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "RenameSession",
      sessionId,
      message: "A Session name can be at most 80 characters; this one is 81.",
    })
    expect((await openWeb(hub, "bob")).sessions.sessions).toEqual([
      expect.objectContaining({ id: sessionId, name: "Health check" }),
    ])

    web.send({ _tag: "RenameSession", sessionId: "no-such-session", name: "x" })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "RenameSession",
      message: "There is no such Session.",
    })
  })

  test("an Archived Session can be renamed, and keeps its name through a restore", async () => {
    const scene = await sessionScene()
    const { web, sessionId } = scene
    await archived(scene)
    web.send({ _tag: "RenameSession", sessionId, name: "Spike" })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.name === "Spike")).session.state,
    ).toBe("Archived")
    web.send({ _tag: "RestoreSession", sessionId })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.state === "Asleep")).session.name,
    ).toBe("Spike")
  })

  test("a name outlives a Hub restart", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: { devLogin: true }, database })
      const { runner, web, sessionId } = await sessionScene(first)
      web.send({ _tag: "RenameSession", sessionId, name: "Health check" })
      await web.take("SessionUpdated", (m) => m.session.name === "Health check")
      await web.close()
      await runner.close()
      await first.stop()

      const second = await startHub({ config: { devLogin: true }, database })
      const back = await openWeb(second, "alice", web.cookie)
      expect(back.sessions.sessions).toEqual([
        expect.objectContaining({ id: sessionId, name: "Health check" }),
      ])
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const keptAwake = (m: Extract<Web, { _tag: "SessionUpdated" }>) => m.session.keepAwake !== undefined
const notKeptAwake = (m: Extract<Web, { _tag: "SessionUpdated" }>) =>
  m.session.keepAwake === undefined

describe("Keep awake (ADR 0016)", () => {
  test("its Creator can turn it on, every client sees who, and an idle Session stays up", async () => {
    const hub = await hubSleepingAfter(300)
    const bobWeb = await openWeb(hub, "bob")
    const { runner, web, sessionId } = await sessionScene(hub)
    web.send({ _tag: "SetKeepAwake", sessionId, on: true })
    for (const client of [web, bobWeb]) {
      const on = await client.take("SessionUpdated", keptAwake)
      expect(on.session.keepAwake?.by).toEqual(alice)
      expect(on.session.keepAwake?.at).toBeGreaterThan(0)
    }
    expect((await openWeb(hub, "carol")).sessions.sessions[0]?.keepAwake?.by).toEqual(alice)

    // Idle well past its wait, it isn't put to sleep.
    await Bun.sleep(600)
    expect(await runner.untaken("StopSession")).toEqual([])

    // Turning it on again changes nothing; off, it is idle again, and sleeps.
    web.send({ _tag: "SetKeepAwake", sessionId, on: true })
    expect((await bobWeb.untaken("SessionUpdated")).filter(keptAwake)).toEqual([])
    web.send({ _tag: "SetKeepAwake", sessionId, on: false })
    await bobWeb.take("SessionUpdated", notKeptAwake)
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
  })

  test("pressing Sleep turns it off, unless Sleep is refused", async () => {
    const scene = await sessionScene()
    const { web, sessionId, mod } = scene
    web.send({ _tag: "SetKeepAwake", sessionId, on: true })
    await web.take("SessionUpdated", keptAwake)

    await mod.post(turnStarted("t-1"))
    web.send({ _tag: "SleepSession", sessionId })
    expect((await web.take("CommandFailed")).command).toBe("SleepSession")
    expect((await openWeb(scene.hub, "bob")).sessions.sessions[0]?.keepAwake?.by).toEqual(alice)
    await mod.post(turnEnded("t-1"))

    await asleep(scene)
    const [after] = (await openWeb(scene.hub, "carol")).sessions.sessions
    expect(after?.state).toBe("Asleep")
    expect(after?.keepAwake).toBeUndefined()
  })

  test("turning it on wakes an Asleep Session", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId } = scene
    await asleep(scene)
    web.send({ _tag: "SetKeepAwake", sessionId, on: true })
    expect(await runner.take("StartSession")).toMatchObject({
      sessionId,
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    const active = await web.take(
      "SessionUpdated",
      (m) => m.session.state === "Active" && m.session.keepAwake !== undefined,
    )
    expect(active.session.keepAwake?.by).toEqual(alice)
    expect(active.session.starting).toBeDefined()
  })

  test("its Runner back from a restart wakes it, and it outlives a Hub restart", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: { devLogin: true }, database })
      const { runner, runnerToken, web, sessionId } = await sessionScene(first)
      web.send({ _tag: "SetKeepAwake", sessionId, on: true })
      await web.take("SessionUpdated", keptAwake)

      // The Runner restarted, and its Claude Code with it: the Session is woken.
      await runner.close()
      await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
      const back = await openRunner(first, runnerToken, [])
      expect(await back.take("StartSession")).toMatchObject({
        sessionId,
        resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      })
      back.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
      await web.take("SessionUpdated", (m) => m.session.state === "Active" && !m.session.starting)
      await web.close()
      await back.close()
      await first.stop()

      const second = await startHub({ config: { devLogin: true }, database })
      const again = await openWeb(second, "alice", web.cookie)
      expect(again.sessions.sessions[0]?.keepAwake?.by).toEqual(alice)
      const runnerAgain = await openRunner(second, runnerToken, [])
      expect(await runnerAgain.take("StartSession")).toMatchObject({ sessionId })
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a Session without it stays Asleep when its Runner is back", async () => {
    const { hub, runner, runnerToken, web } = await sessionScene()
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    const back = await openRunner(hub, runnerToken, [])
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(await back.untaken("StartSession")).toEqual([])
  })

  test("archiving turns it off, and an Archived Session can't be kept awake", async () => {
    const scene = await sessionScene()
    const { web, sessionId } = scene
    web.send({ _tag: "SetKeepAwake", sessionId, on: true })
    await web.take("SessionUpdated", keptAwake)
    expect((await archived(scene)).keepAwake).toBeUndefined()

    web.send({ _tag: "SetKeepAwake", sessionId, on: true })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "SetKeepAwake",
      sessionId,
      message: "The Session is archived.",
    })
    web.send({ _tag: "RestoreSession", sessionId })
    const restored = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(restored.session.keepAwake).toBeUndefined()
  })
})

// What a Runner's Claude Code says it has (#128), as Claude Code 2.1.289 resolves its aliases.
const opus = {
  alias: "opus",
  id: "claude-opus-5-5",
  label: "Opus 5.5",
  description: "Best for everyday, complex tasks",
  reasoning: true,
}
const runnerModels = {
  default: { ...opus, alias: "default" },
  models: [
    opus,
    {
      alias: "sonnet",
      id: "claude-sonnet-5-5",
      label: "Sonnet 5.5",
      description: "Efficient for routine tasks",
      reasoning: true,
    },
    {
      alias: "haiku",
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      description: "Fastest for quick answers",
      reasoning: false,
    },
  ],
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
}
/** A Runner as it says hello since #128: taking RelaunchSession, and with its Claude Code's models. */
const modelRunner = { runnerHello: { models: runnerModels, relaunches: true } }

type Scene = Awaited<ReturnType<typeof sessionScene>>

const modelSwitched = (m: Extract<Web, { _tag: "SessionEventLogged" }>) =>
  m.entry.event._tag === "ModelSwitched"

/** The RelaunchSession the Runner is sent, answered as the Runner does, and the new mod's hello. */
async function relaunched(scene: Scene) {
  const { hub, runner, sessionId } = scene
  const relaunch = await runner.take("RelaunchSession")
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  const mod = new Mod(hub, sessionId, relaunch.modToken)
  expect((await mod.hello()).status).toBe(200)
  return { relaunch, mod }
}

describe("model and thinking level (#128)", () => {
  test("anyone can change it, to one of its Creator's Models: everyone sees it, and the history says who", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { hub, web, sessionId, session } = scene
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    joinSession(bobWeb, sessionId)
    // Every joiner is sent its Creator's Models, Claude's with a Claude credential.
    const models = (await bobWeb.take("SessionModels")).models
    expect(models[0]?.provider).toBe("anthropic")
    const other = defined(models.find((model) => `${model.provider}/${model.id}` !== session.model))
    const name = `${other.provider}/${other.id}`

    // Bob didn't create it, and may change it all the same (the Pi Durable spike).
    bobWeb.send({ _tag: "SetSessionModel", sessionId, model: name })
    for (const client of [web, bobWeb]) {
      const changed = await client.take("SessionUpdated", (m) => m.session.model === name)
      expect(changed.session).toEqual({ ...session, model: name, modelPending: true })
    }
    expect((await web.take("SessionEventLogged", modelSwitched)).entry.event).toEqual({
      _tag: "ModelSwitched",
      by: bob,
      model: name,
      modelLabel: other.label,
    })

    // Claude Code's names, and Models the Creator hasn't, are refused.
    bobWeb.send({ _tag: "SetSessionModel", sessionId, model: "sonnet" })
    expect((await bobWeb.take("CommandFailed")).message).toBe(
      "'sonnet' is Claude Code's name for a model, and Sessions no longer run on Claude Code: pick one of your Models, named <provider>/<id>, such as anthropic/claude-opus-5-5.",
    )
    bobWeb.send({ _tag: "SetSessionModel", sessionId, model: "openai/gpt-6-sol" })
    expect((await bobWeb.take("CommandFailed")).message).toBe("Model 'openai/gpt-6-sol' not found")
  })

  test("an Asleep Session starts with it when it wakes", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { runner, web, sessionId, session } = scene
    await asleep(scene)
    joinSession(web, sessionId)
    const models = (await web.take("SessionModels")).models
    const other = defined(models.find((model) => `${model.provider}/${model.id}` !== session.model))
    const name = `${other.provider}/${other.id}`
    web.send({ _tag: "SetSessionModel", sessionId, model: name })
    const changed = await web.take("SessionUpdated", (m) => m.session.model === name)
    expect(changed.session).not.toHaveProperty("modelPending")

    web.send({ _tag: "WakeSession", sessionId })
    expect(await runner.take("StartSession")).toMatchObject({
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      harness: "Pi",
      model: name,
    })
    expect(await runner.untaken("RelaunchSession")).toEqual([])
  })

  test("an agent that doesn't start again leaves the Session Asleep, saying why", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "SetSessionModel", sessionId, thinkingLevel: "low" })
    await runner.take("RelaunchSession")
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "tmux is gone" })
    const asleepNow = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(asleepNow.session).toMatchObject({ thinkingLevel: "low" })
    expect(asleepNow.session).not.toHaveProperty("modelPending")
    expect(
      (await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event,
    ).toMatchObject({ message: "The agent could not start on mac: tmux is gone" })
  })

  test("an Archived Session's model can't be changed", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    await archived(scene)
    scene.web.send({ _tag: "SetSessionModel", sessionId: scene.sessionId, thinkingLevel: "low" })
    expect((await scene.web.take("CommandFailed")).message).toBe(
      "The Session is archived: restore it to change its model.",
    )
  })
})

// What a Member's Connected providers and Claude credential give their pi Sessions (ADR 0029).
const gpt = {
  provider: "openai",
  id: "gpt-6-sol",
  label: "GPT-6-Sol",
  thinkingLevels: ["low", "medium", "high"],
} as const
const grok = { provider: "xai", id: "grok-5", label: "Grok 5", thinkingLevels: [] } as const
const claudeOpus = {
  provider: "anthropic",
  id: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  thinkingLevels: ["low", "medium", "high", "max"],
} as const
type TestModel = typeof gpt | typeof grok | typeof claudeOpus

/** A Runner as it says hello with its pi bundle ready. */
const piRunner = {
  runnerHello: { models: runnerModels, relaunches: true, harnesses: ["ClaudeCode", "Pi"] },
}

/** A pi Session on a Runner that runs pi, on its Creator's first Model, as asked for. */
const piSession = { ...piRunner, create: { harness: "Pi" } }

/** A Hub whose Members' pi Sessions can run `models`, which a test may change as it goes. */
async function piHub(
  models: ReadonlyArray<TestModel>,
  database?: Layer.Layer<SqlClient.SqlClient, unknown>,
) {
  const catalogue = { models }
  const hub = await startHub({
    config: { devLogin: true },
    ...(database !== undefined && { database }),
    modelCatalog: Layer.succeed(ModelCatalog, {
      modelsFor: () => Effect.sync(() => catalogue.models),
      signedIn: () => Effect.succeed([]),
    }),
  })
  return { hub, catalogue }
}

describe("the durable agent's Sessions (ADR 0029, docs/design/durable-harness.md)", () => {
  test("a new Session is pi on a Runner that runs it, on its Creator's first Model, Claude's first", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const { start, session } = await sessionScene(hub, piSession)
    expect(start).toMatchObject({ harness: "Pi", model: "anthropic/claude-opus-5-5" })
    expect(start).not.toHaveProperty("thinkingLevel")
    expect(session).toMatchObject({ harness: "Pi", model: "anthropic/claude-opus-5-5" })
    // The web hears which Harnesses the Runner runs.
    expect((await openWeb(hub, "bob")).runners.runners).toMatchObject([
      { name: "mac", harnesses: ["ClaudeCode", "Pi"] },
    ])

    // Without Claude's, the first of the others.
    const other = await sessionScene((await piHub([gpt, grok])).hub, piRunner)
    expect(other.start).toMatchObject({ harness: "Pi", model: "openai/gpt-6-sol" })
  })

  test("a new Session is refused on a Runner from before the durable agent, and Claude Code is refused", async () => {
    const { hub } = await piHub([gpt])
    await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
      harnesses: ["ClaudeCode"],
    })
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    const create = async (more: Record<string, unknown>) => {
      web.send({
        _tag: "CreateSession",
        requestId: "r",
        repo: "kddige/kndl",
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
        ...more,
      })
      return (await web.take("CommandFailed")).message
    }
    expect(await create({})).toBe(
      "mac runs a version from before the durable agent: update it on the Runners page.",
    )
    expect(await create({ harness: "ClaudeCode" })).toBe(
      "Claude Code no longer runs Sessions: they run on the durable agent, on your Models.",
    )
    expect(await web.untaken("SessionCreated")).toEqual([])
  })

  test("a model, thinking level or Harness the Creator or Runner can't have is refused", async () => {
    const { hub, catalogue } = await piHub([gpt, grok])
    await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
      ...piRunner.runnerHello,
    })
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    const create = async (more: Record<string, unknown>) => {
      web.send({
        _tag: "CreateSession",
        requestId: "r",
        repo: "kddige/kndl",
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
        ...more,
      })
      return (await web.take("CommandFailed")).message
    }

    // Claude Code's names are no Session's now.
    expect(await create({ harness: "Pi", model: "sonnet" })).toBe(
      "'sonnet' is Claude Code's name for a model, and Sessions no longer run on Claude Code: pick one of your Models, named <provider>/<id>, such as anthropic/claude-opus-5-5.",
    )
    expect(await create({ model: "openai/gpt-5" })).toBe("Model 'openai/gpt-5' not found")
    expect(await create({ model: "xai/grok-5", thinkingLevel: "low" })).toBe(
      "Grok 5 takes no thinking level.",
    )
    expect(await create({ model: "openai/gpt-6-sol", thinkingLevel: "max" })).toBe(
      "GPT-6-Sol has no thinking level 'max'.",
    )
    catalogue.models = []
    expect(await create({})).toBe(
      "You have no Models to run a Session on: connect a Provider on the Account page.",
    )
    expect(await web.untaken("SessionCreated")).toEqual([])
  })

  test("a chosen model and thinking level start it, and are its setting", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const { start, session } = await sessionScene(hub, {
      ...piRunner,
      create: { model: "openai/gpt-6-sol", thinkingLevel: "high" },
    })
    expect(start).toMatchObject({ harness: "Pi", model: "openai/gpt-6-sol", thinkingLevel: "high" })
    expect(session).toMatchObject({ model: "openai/gpt-6-sol", thinkingLevel: "high" })
  })

  test("its model switches between Turns with a SwitchModel, to a mod that switches models", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const scene = await sessionScene(hub, piSession)
    const { runner, web, sessionId, mod } = scene
    expect((await mod.hello({ switchesModels: true })).status).toBe(200)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post(turnStarted("t-1"))
    await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")

    web.send({ _tag: "SetSessionModel", sessionId, model: "anthropic/claude-opus" })
    expect((await web.take("CommandFailed")).message).toBe(
      "Model 'anthropic/claude-opus' not found",
    )
    web.send({
      _tag: "SetSessionModel",
      sessionId,
      model: "openai/gpt-6-sol",
      thinkingLevel: "low",
    })
    expect((await web.take("SessionEventLogged", modelSwitched)).entry.event).toEqual({
      _tag: "ModelSwitched",
      by: alice,
      model: "openai/gpt-6-sol",
      modelLabel: "GPT-6-Sol",
      thinkingLevel: "low",
    })
    await web.take("SessionUpdated", (m) => m.session.modelPending === true)
    web.send({ _tag: "SendPrompt", sessionId, text: "next" })
    // Never mid-Turn.
    expect(await mod.next("SwitchModel")).toEqual([])

    await mod.post(turnEnded("t-1"))
    const commands = await mod.poll(500)
    expect(commands.map((command) => command._tag)).toEqual(["SwitchModel", "DeliverPrompt"])
    expect(commands[0]).toEqual({
      _tag: "SwitchModel",
      sessionId,
      model: "openai/gpt-6-sol",
      thinkingLevel: "low",
    })
    const settled = await web.take(
      "SessionUpdated",
      (m) => m.session.model === "openai/gpt-6-sol" && m.session.modelPending === undefined,
    )
    expect(settled.session).toMatchObject({ thinkingLevel: "low", state: "Active" })
    expect(await runner.untaken("RelaunchSession")).toEqual([])
  })

  test("a switch the mod couldn't make leaves the Session on its model, and its history says why", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const { web, sessionId, mod } = await sessionScene(hub, piSession)
    expect((await mod.hello({ switchesModels: true })).status).toBe(200)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post({
      _tag: "ModelSwitchFailed",
      asked: "openai/gpt-6-sol",
      model: "anthropic/claude-opus-5-5",
      message: "pi has no Model openai/gpt-6-sol",
    })
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SandboxNoted")).entry
        .event,
    ).toEqual({
      _tag: "SandboxNoted",
      message:
        "Couldn't switch to openai/gpt-6-sol: pi has no Model openai/gpt-6-sol. It still runs on anthropic/claude-opus-5-5.",
    })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.model === "anthropic/claude-opus-5-5"))
        .session.modelPending,
    ).toBeUndefined()
  })

  test("a failed switch keeps the thinking level, and takes only a model of the Creator's as the one it runs", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const { web, sessionId, mod } = await sessionScene(hub, piSession)
    expect((await mod.hello({ switchesModels: true })).status).toBe(200)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({
      _tag: "SetSessionModel",
      sessionId,
      model: "openai/gpt-6-sol",
      thinkingLevel: "low",
    })
    await web.take("SessionUpdated", (m) => m.session.thinkingLevel === "low")
    await mod.post({
      _tag: "ModelSwitchFailed",
      asked: "openai/gpt-6-sol",
      model: "anthropic/claude-opus-5-5",
      message: "no such model",
    })
    // Back on the model it ran on, at the level set, after the switch.
    await web.take(
      "SessionUpdated",
      (m) => m.session.model === "anthropic/claude-opus-5-5" && m.session.thinkingLevel === "low",
    )

    await mod.post({
      _tag: "ModelSwitchFailed",
      asked: "openai/gpt-6-sol",
      model: "openai/not-the-creators",
      message: "no such model",
    })
    await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SandboxNoted")
    const summaries = await web.untaken("SessionUpdated")
    expect(summaries.some((m) => m.session.model === "openai/not-the-creators")).toBe(false)
  })

  test("a switch that failed after a newer one was asked for leaves the newer one set", async () => {
    const { hub } = await piHub([gpt, grok, claudeOpus])
    const { web, sessionId, mod } = await sessionScene(hub, piSession)
    expect((await mod.hello({ switchesModels: true })).status).toBe(200)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "SetSessionModel", sessionId, model: "openai/gpt-6-sol" })
    await web.take("SessionUpdated", (m) => m.session.model === "openai/gpt-6-sol")
    web.send({ _tag: "SetSessionModel", sessionId, model: "xai/grok-5" })
    await web.take("SessionUpdated", (m) => m.session.model === "xai/grok-5")
    expect((await mod.next("SwitchModel", 500)).map((command) => command.model)).toEqual([
      "openai/gpt-6-sol",
      "xai/grok-5",
    ])
    const before = (await web.untaken("SessionUpdated")).length

    // pi says the first failed only now.
    await mod.post({
      _tag: "ModelSwitchFailed",
      asked: "openai/gpt-6-sol",
      model: "anthropic/claude-opus-5-5",
      message: "no such model",
    })
    await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SandboxNoted")
    const since = (await web.untaken("SessionUpdated")).slice(before)
    expect(since.map((m) => m.session.model)).toEqual(["xai/grok-5"])
  })

  test("its Harness is started again with it, for a mod that doesn't switch models", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const scene = await sessionScene(hub, piSession)
    scene.web.send({
      _tag: "SetSessionModel",
      sessionId: scene.sessionId,
      model: "openai/gpt-6-sol",
    })
    const { relaunch, mod } = await relaunched(scene)
    // Still pi's: a RelaunchSession without a Harness is Claude Code's.
    expect(relaunch).toMatchObject({
      harness: "Pi",
      model: "openai/gpt-6-sol",
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    expect(await mod.next("SwitchModel")).toEqual([])
  })

  test("what it says of its start and exit names the agent, and anyone drives it", async () => {
    const { hub } = await piHub([gpt])
    const { runner, web, sessionId } = await sessionScene(hub, piRunner)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    const wentToSleep = async () =>
      (await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })
    expect(await wentToSleep()).toMatchObject({ message: "The agent exited with code 1" })
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    expect(
      (await web.take("SessionEventLogged", stateChanged("Active"))).entry.event,
    ).toMatchObject({ message: "The agent started on mac" })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited" })
    expect(await wentToSleep()).toMatchObject({ message: "The agent exited" })

    web.send({ _tag: "WakeSession", sessionId })
    await runner.take("StartSession")
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "tmux is gone" })
    expect(await wentToSleep()).toMatchObject({
      message: "The agent could not start on mac: tmux is gone",
    })

    // Bob's prompt wakes it, on alice's Models.
    const bobWeb = await openWeb(hub, "bob")
    bobWeb.send({ _tag: "SendPrompt", sessionId, text: "hi" })
    expect(await runner.take("StartSession")).toMatchObject({ model: "openai/gpt-6-sol" })
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
  })

  test("its Creator needs Models to start and wake it, not a Claude credential", async () => {
    const { hub, catalogue } = await piHub([gpt])
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
      ...piRunner.runnerHello,
    })
    const web = await openWeb(hub, "alice", undefined, { setupToken: false })
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    const create = (more: Record<string, unknown>) =>
      web.send({
        _tag: "CreateSession",
        requestId: "r",
        repo: "kddige/kndl",
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
        ...more,
      })

    create({})
    const start = await runner.take("StartSession")
    expect(start).toMatchObject({ harness: "Pi", model: "openai/gpt-6-sol" })
    const { sessionId } = start
    // The Runner still asks for the Claude credential, for Claude's Models, and is refused.
    runner.send({ _tag: "FetchClaudeCredential", requestId: "c-1", sessionId })
    expect(await runner.take("ClaudeCredentialRefused")).toMatchObject({ requestId: "c-1" })
    const mod = new Mod(hub, sessionId, start.modToken)
    expect((await mod.hello()).status).toBe(200)
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    await web.take("SessionUpdated", (m) => m.session.id === sessionId && !m.session.starting)
    web.send({ _tag: "SleepSession", sessionId })
    await runner.take("StopSession")
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")

    // Its Models gone, it doesn't wake.
    catalogue.models = []
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "WakeSession", sessionId })
    const refused = await web.take("SessionEventLogged", stateChanged("Asleep"))
    expect(refused.entry.event).toMatchObject({
      message:
        "The agent could not start: You have no Models to run a Session on: connect a Provider on the Account page.",
    })
    expect(await runner.untaken("StartSession")).toEqual([])

    catalogue.models = [gpt]
    web.send({ _tag: "WakeSession", sessionId })
    expect(await runner.take("StartSession")).toMatchObject({
      harness: "Pi",
      model: "openai/gpt-6-sol",
      resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
  })
})

/** Another conversation than the one the fake mod says hello with by default: pi's. */
const piConversation = "5e0c9d2a-7b1f-4e8a-9c3d-2f1a0b9c8d7e"

/** A Turn alice prompted, answered, and ended. */
const answered = (
  turnId: string,
  text: string,
  answer: string,
  promptId?: string,
): Array<ModEvent> => [
  {
    _tag: "TurnStarted",
    turnId,
    text,
    sender: { _tag: "FromParticipant", participant: alice },
    ...(promptId === undefined ? {} : { promptId }),
  },
  { _tag: "TextDelta", turnId, text: answer },
  turnEnded(turnId),
]

const turnEndedLogged = (turnId: string) => (m: Extract<Web, { _tag: "SessionEventLogged" }>) =>
  m.entry.event._tag === "TurnEnded" && m.entry.event.turnId === turnId

/** The commands but presence, which a joined client's comings and goings queue. */
const withoutPresence = (commands: ReadonlyArray<Command>) =>
  commands.filter((command) => command._tag !== "PresenceChanged")

/**
 * Makes the Session one from before the durable agent, as a Hub updated to it finds one: on Claude
 * Code, with a model of Claude Code's (`model`), its conversation and subagents Claude Code's.
 */
const fromBefore = (hub: TestHub, sessionId: string, model = "sonnet") =>
  hub.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all([
        sql`UPDATE sessions SET harness = NULL, model = ${model} WHERE id = ${sessionId}`,
        sql`UPDATE session_conversations SET harness = 'ClaudeCode' WHERE session_id = ${sessionId}`,
        sql`UPDATE agents SET harness = NULL WHERE session_id = ${sessionId}`,
      ]),
    ),
  )

describe("Sessions from before the durable agent", () => {
  test("one on Claude Code wakes on the durable agent, on its Creator's default Model, and is handed what Claude Code saw", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const scene = await sessionScene(hub, piSession)
    const { runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await scene.mod.post(...answered("t-1", "Add a health check", "Added /health."))
    await asleep(scene)
    await fromBefore(hub, sessionId)

    web.send({ _tag: "SendPrompt", sessionId, text: "next" })
    const start = await runner.take("StartSession")
    expect(start).toMatchObject({ harness: "Pi", model: "anthropic/claude-opus-5-5" })
    // Claude Code's conversation isn't the durable agent's.
    expect(start).not.toHaveProperty("resume")
    expect(
      (await web.take("SessionEventLogged", stateChanged("Active"))).entry.event,
    ).toMatchObject({ message: "Woken on mac: it runs on the durable agent now" })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.harness === "Pi")).session,
    ).toMatchObject({ model: "anthropic/claude-opus-5-5" })
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const mod = new Mod(hub, sessionId, start.modToken)
    expect((await mod.hello({ conversationId: piConversation, durable: true })).status).toBe(200)
    const commands = withoutPresence(await mod.poll(500))
    expect(commands.map((command) => command._tag)).toEqual(["DeliverHandoff", "DeliverPrompt"])
    const [handoff, prompt] = commands as [
      Extract<Command, { _tag: "DeliverHandoff" }>,
      Extract<Command, { _tag: "DeliverPrompt" }>,
    ]
    expect(handoff).toMatchObject({ from: "ClaudeCode" })
    expect(handoff.text).toContain("Added /health.")
    await mod.post(...answered("t-2", "next", "Hello.", prompt.promptId))
    await web.take("SessionEventLogged", turnEndedLogged("t-2"))

    // Collected, it isn't handed again; its next wake resumes the durable agent's conversation.
    await mod.poll()
    await asleep(scene)
    web.send({ _tag: "WakeSession", sessionId })
    const again = await runner.take("StartSession")
    expect(again).toMatchObject({ harness: "Pi", resume: piConversation })
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const next = new Mod(hub, sessionId, again.modToken)
    expect((await next.hello({ conversationId: piConversation, durable: true })).status).toBe(200)
    expect(await next.next("DeliverHandoff", 100)).toEqual([])
  })

  test("one that ran on the old pi extension, as migration 0047 leaves it, wakes on a new conversation and is handed its history", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const scene = await sessionScene(hub, piSession)
    const { runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await scene.mod.post(...answered("t-1", "Add a health check", "Added /health."))
    await asleep(scene)
    // Stored as Pi, with the pi extension's conversation forgotten and a full handoff due.
    await hub.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`UPDATE sessions SET handoff_from = 'Pi' WHERE id = ${sessionId}`,
          sql`DELETE FROM session_conversations WHERE session_id = ${sessionId}`,
        ]),
      ),
    )

    web.send({ _tag: "SendPrompt", sessionId, text: "next" })
    const start = await runner.take("StartSession")
    expect(start).toMatchObject({ harness: "Pi" })
    expect(start).not.toHaveProperty("resume")
    expect(
      (await web.take("SessionEventLogged", stateChanged("Active"))).entry.event,
    ).toMatchObject({ message: "Woken on mac: it runs on the durable agent now" })
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const mod = new Mod(hub, sessionId, start.modToken)
    expect((await mod.hello({ conversationId: piConversation, durable: true })).status).toBe(200)
    const commands = withoutPresence(await mod.poll(500))
    expect(commands.map((command) => command._tag)).toEqual(["DeliverHandoff", "DeliverPrompt"])
    const [handoff] = commands as [Extract<Command, { _tag: "DeliverHandoff" }>]
    expect(handoff).toMatchObject({ from: "Pi" })
    expect(handoff.text).toContain("Added /health.")
  })

  test("one whose model is one of its Creator's Models keeps it", async () => {
    const { hub } = await piHub([gpt, claudeOpus])
    const scene = await sessionScene(hub, piSession)
    await asleep(scene)
    await fromBefore(hub, scene.sessionId, "openai/gpt-6-sol")
    scene.web.send({ _tag: "WakeSession", sessionId: scene.sessionId })
    expect(await scene.runner.take("StartSession")).toMatchObject({
      harness: "Pi",
      model: "openai/gpt-6-sol",
    })
  })

  test("one whose Creator has no Models doesn't wake, saying why", async () => {
    const { hub, catalogue } = await piHub([gpt])
    const scene = await sessionScene(hub, piSession)
    const { web, runner, sessionId } = scene
    await asleep(scene)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await fromBefore(hub, sessionId)
    catalogue.models = []
    web.send({ _tag: "WakeSession", sessionId })
    expect(
      (await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event,
    ).toMatchObject({
      message:
        "The agent could not start: You have no Models to run a Session on: connect a Provider on the Account page.",
    })
    expect(await runner.untaken("StartSession")).toEqual([])
  })

  test("a subagent Claude Code started can't be messaged or stopped by the durable agent", async () => {
    const { hub } = await piHub([gpt])
    const scene = await sessionScene(hub, piSession)
    const { web, sessionId, mod } = scene
    await mod.post(turnStarted("t-1"), agentStarted("a-1", "Check the docs"))
    await web.take("SessionUpdated", (m) => (m.session.agents ?? []).length > 0)
    await fromBefore(hub, sessionId)
    for (const command of [
      { _tag: "MessageAgent", text: "and the tests" },
      { _tag: "StopAgent" },
    ] as const) {
      web.send({ ...command, sessionId, agentId: "a-1" })
      expect((await web.take("CommandFailed")).message).toBe(
        `Check the docs ran on Claude Code, which no longer runs this Session: the agent can't ${command._tag === "StopAgent" ? "stop" : "message"} it.`,
      )
    }
  })
})

describe("GET /mod/history (ADR 0030)", () => {
  test("gives the agent the Session's Turns, a page at a time, oldest first, and where the earlier ones start", async () => {
    const { hub, mod, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post(
      ...answered("t-1", "one", "1"),
      ...answered("t-2", "two", "2"),
      ...answered("t-3", "three", "3"),
    )
    await web.take("SessionEventLogged", turnEndedLogged("t-3"))

    const all = await mod.history()
    expect(all.status).toBe(200)
    const { turns } = (await all.json()) as {
      turns: Array<{ readonly seq: number } & Record<string, unknown>>
    }
    expect(turns).toEqual([
      { seq: expect.any(Number), by: "alice", prompt: "one", tools: [], answer: "1" },
      { seq: expect.any(Number), by: "alice", prompt: "two", tools: [], answer: "2" },
      { seq: expect.any(Number), by: "alice", prompt: "three", tools: [], answer: "3" },
    ])
    const page = (await (await mod.history("?limit=2")).json()) as {
      turns: Array<{ prompt: string }>
      earlierBefore: number
    }
    expect(page.turns.map((turn) => turn.prompt)).toEqual(["two", "three"])
    expect(page.earlierBefore).toBe(defined(turns[1]).seq)
    expect(await (await mod.history(`?before=${page.earlierBefore}`)).json()).toEqual({
      turns: [{ seq: defined(turns[0]).seq, by: "alice", prompt: "one", tools: [], answer: "1" }],
    })

    expect((await mod.history("?limit=0")).status).toBe(400)
    expect((await mod.history("?before=soon")).status).toBe(400)
    expect((await fetch(`${hub.url}/mod/history`)).status).toBe(401)
  })
})

describe("the terminal relay", () => {
  test("relays frames to the clients that opened the terminal, and keystrokes to the Runner", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")
    web.send({ _tag: "OpenTerminal", sessionId })
    expect(await runner.take("RequestTerminalSnapshot")).toEqual({
      _tag: "RequestTerminalSnapshot",
      sessionId,
    })

    const frame = {
      _tag: "TerminalFrame",
      sessionId,
      kind: "Snapshot",
      data: "$ ",
      size: { cols: 80, rows: 24 },
    } as const
    runner.send(frame)
    expect(await web.take("TerminalFrame")).toEqual(frame)
    expect(await bobWeb.untaken("TerminalFrame")).toEqual([])

    web.send({ _tag: "TerminalInput", sessionId, data: "ls\r" })
    web.send({ _tag: "TerminalResize", sessionId, size: { cols: 100, rows: 30 } })
    expect(await runner.take("TerminalInput")).toEqual({
      _tag: "TerminalInput",
      sessionId,
      data: "ls\r",
    })
    expect(await runner.take("TerminalResize")).toEqual({
      _tag: "TerminalResize",
      sessionId,
      size: { cols: 100, rows: 30 },
    })

    web.send({ _tag: "CloseTerminal", sessionId })
    runner.send({ ...frame, kind: "Output", data: "README.md" })
    expect(await web.untaken("TerminalFrame")).toEqual([])
  })

  test("before Claude Code's terminal is up, its output is the start's log, for joined clients", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    const { sessionId } = await runner.take("StartSession")
    const { since } = defined((await web.take("SessionCreated")).session.starting)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    const output = (data: string) =>
      runner.send({
        _tag: "TerminalFrame",
        sessionId,
        kind: "Output",
        data,
        size: { cols: 120, rows: 40 },
      })

    output("Step 1/2\r\n")
    expect(await web.take("SessionStartLogged")).toEqual({
      _tag: "SessionStartLogged",
      sessionId,
      since,
      data: "Step 1/2\r\n",
    })
    output("Step 2/2\r\n")
    await web.take("SessionStartLogged", (m) => m.data === "Step 2/2\r\n")

    // A late joiner gets it so far, in one piece.
    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    expect(await bobWeb.take("SessionStartLogged")).toEqual({
      _tag: "SessionStartLogged",
      sessionId,
      since,
      data: "Step 1/2\r\nStep 2/2\r\n",
      replace: true,
    })

    // Once Claude Code's terminal is up, its output is the Terminal tab's alone.
    runner.send({
      _tag: "TerminalFrame",
      sessionId,
      kind: "Snapshot",
      data: "claude",
      size: { cols: 120, rows: 40 },
    })
    output("hello from claude")
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    await web.take("SessionUpdated", (m) => m.session.starting === undefined)
    expect(await web.untaken("SessionStartLogged")).toEqual([])
    const carol = await openWeb(hub, "carol")
    joinSession(carol, sessionId)
    await carol.take("SessionHistory")
    expect(await carol.untaken("SessionStartLogged")).toEqual([])
  })

  test("takes keystrokes only from a connection watching the terminal", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    const tab = await openWeb(hub, "alice", web.cookie)
    tab.send({ _tag: "TerminalInput", sessionId, data: "rm -rf /\r" })
    tab.send({ _tag: "TerminalResize", sessionId, size: { cols: 10, rows: 5 } })
    for (const command of ["TerminalInput", "TerminalResize"]) {
      expect(await tab.take("CommandFailed")).toMatchObject({
        command,
        message: "Open the Session's terminal first.",
      })
    }
    web.send({ _tag: "TerminalInput", sessionId: "s-nonexistent", data: "x" })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "TerminalInput" })
    expect(await runner.untaken("TerminalInput")).toEqual([])
    expect(await runner.untaken("TerminalResize")).toEqual([])
  })

  test("takes no keystrokes while the Session isn't running, and watches until it is", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId } = scene
    await asleep(scene)

    // Watching an Asleep Session asks the Runner for nothing; typing into it is refused.
    web.send({ _tag: "OpenTerminal", sessionId })
    web.send({ _tag: "TerminalInput", sessionId, data: "\u001b" })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "TerminalInput",
      sessionId,
      message: "The Session is Asleep: its terminal isn't running.",
    })
    expect(await runner.untaken("RequestTerminalSnapshot")).toEqual([])
    expect(await runner.untaken("TerminalInput")).toEqual([])

    // Woken: the Runner's snapshot on attaching reaches the watcher, and keystrokes go through.
    web.send({ _tag: "WakeSession", sessionId })
    await runner.take("StartSession")
    runner.send({ _tag: "SessionStarted", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    const snapshot = {
      _tag: "TerminalFrame",
      sessionId,
      kind: "Snapshot",
      data: "welcome back",
      size: { cols: 120, rows: 40 },
    } as const
    runner.send(snapshot)
    expect(await web.take("TerminalFrame")).toEqual(snapshot)
    web.send({ _tag: "TerminalInput", sessionId, data: "\u0003" })
    expect(await runner.take("TerminalInput")).toMatchObject({ data: "\u0003" })
  })

  test("a terminal opened while its Runner is offline gets the snapshot it sends on return", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "OpenTerminal", sessionId })
    web.send({ _tag: "TerminalResize", sessionId, size: { cols: 90, rows: 20 } })
    expect((await web.take("CommandFailed")).message).toBe(
      "The Session is Frozen: its terminal isn't running.",
    )

    const back = await openRunner(hub, runnerToken, [sessionId])
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    const frame = {
      _tag: "TerminalFrame",
      sessionId,
      kind: "Snapshot",
      data: "still here",
      size: { cols: 120, rows: 40 },
    } as const
    back.send(frame)
    expect(await web.take("TerminalFrame")).toEqual(frame)
  })

  test("after a Hub restart, a reopened terminal asks the Runner for a fresh snapshot", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: { devLogin: true }, database })
      const { runner, runnerToken, web, sessionId } = await sessionScene(first)
      web.send({ _tag: "OpenTerminal", sessionId })
      await runner.take("RequestTerminalSnapshot")
      await web.close()
      await runner.close()
      await first.stop()

      const second = await startHub({ config: { devLogin: true }, database })
      const webBack = await openWeb(second, "alice", web.cookie)
      const back = await openRunner(second, runnerToken, [sessionId])
      await webBack.take("SessionUpdated", (m) => m.session.state === "Active")
      webBack.send({ _tag: "OpenTerminal", sessionId })
      expect(await back.take("RequestTerminalSnapshot")).toEqual({
        _tag: "RequestTerminalSnapshot",
        sessionId,
      })
      const frame = {
        _tag: "TerminalFrame",
        sessionId,
        kind: "Snapshot",
        data: "$ ",
        size: { cols: 120, rows: 40 },
      } as const
      back.send(frame)
      expect(await webBack.take("TerminalFrame")).toEqual(frame)
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a Hub restart", () => {
  test("keeps Sessions, their history and Prompt queues", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: { devLogin: true }, database })
      const { runner, runnerToken, web, sessionId, mod, session } = await sessionScene(first)
      await mod.post(turnStarted("t-1"))
      joinSession(web, sessionId)
      web.send({ _tag: "SendPrompt", sessionId, text: "one" })
      web.send({ _tag: "SendPrompt", sessionId, text: "two" })
      await web.take("PromptQueueChanged", queueIs("one", "two"))
      const before = await web.take("SessionHistory")
      await web.close()
      await runner.close()
      await first.stop()

      const second = await startHub({ config: { devLogin: true }, database })
      const back = await openWeb(second, "alice", web.cookie)
      expect(back.sessions.sessions).toEqual([{ ...session, state: "Frozen", currentTurn: "t-1" }])

      await openRunner(second, runnerToken, [sessionId])
      await back.take("SessionUpdated", (m) => m.session.state === "Active")
      joinSession(back, sessionId)
      const history = await back.take("SessionHistory")
      expect(history.entries.slice(0, before.entries.length)).toEqual([...before.entries])
      expect(history.entries.slice(-2).map((entry) => entry.event)).toMatchObject([
        { _tag: "SessionStateChanged", state: "Frozen" },
        { _tag: "SessionStateChanged", state: "Active" },
      ])
      expect(queueTexts(await back.take("PromptQueueChanged"))).toEqual(["one", "two"])

      // The restarted Hub's mod says hello again; once the Turn ends, the queue moves on.
      const modAgain = new Mod(second, sessionId, mod.token)
      expect((await modAgain.hello()).status).toBe(200)
      await modAgain.post(turnEnded("t-1"))
      expect((await modAgain.deliveries(500)).map((command) => command.text)).toEqual(["one"])
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("git", () => {
  let requests = 0
  /** Asks the Hub, as the Runner, and waits for its answer. */
  async function ask(
    runner: Connection<ToRunner>,
    sessionId: string,
    question: Tagged & Record<string, unknown>,
  ) {
    requests += 1
    const requestId = `git-${requests}`
    runner.send({ _tag: "GitRequest", requestId, sessionId, ask: question })
    return (await runner.take("GitReply", (reply) => reply.requestId === requestId)).answer
  }

  test("without the GitHub App, Repo access is the host's credentials and the Sandbox gets no token", async () => {
    const { runner, sessionId } = await sessionScene()

    expect(await ask(runner, sessionId, { _tag: "GitAccess" })).toEqual({
      _tag: "GitAccess",
      repo: "kddige/kndl",
      credentials: { _tag: "HostCredentials" },
    })
    const failed = await ask(runner, sessionId, { _tag: "SandboxToken" })
    expect(failed).toMatchObject({ _tag: "GitFailed" })
    expect((failed as { message: string }).message).toContain(
      "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH",
    )
  })

  test("the git tools' requests are gone (#73)", async () => {
    const { runner, sessionId } = await sessionScene()
    for (const removed of [
      { _tag: "CoAuthors" },
      { _tag: "OpenPullRequest", title: "t", body: "", draft: false },
      { _tag: "ReviewPullRequest", number: 1, body: "x", event: "COMMENT" },
    ]) {
      runner.send({ _tag: "GitRequest", requestId: "old", sessionId, ask: removed })
    }
    runner.send({ _tag: "CoAuthorsCommitted", sessionId, through: 1 })
    expect(await runner.untaken("GitReply")).toEqual([])
  })

  test("a Runner can't ask about another Runner's Session", async () => {
    const { hub, sessionId } = await sessionScene()
    const other = await openRunner(hub, (await issueRunnerToken(hub, "other")).token)
    other.send({ _tag: "GitRequest", requestId: "x", sessionId, ask: { _tag: "GitAccess" } })
    expect(await other.untaken("GitReply")).toEqual([])
  })

  test("a failed push from a Runner from before #194 is dropped, and the Runner kept", async () => {
    const { runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")

    runner.send({ _tag: "WipPushFailed", sessionId, message: "remote rejected" })
    runner.send({ _tag: "SandboxNote", sessionId, message: "Capped at 4 CPUs" })
    expect((await web.take("SessionEventLogged")).entry.event).toEqual({
      _tag: "SandboxNoted",
      message: "Capped at 4 CPUs",
    })
    expect(await web.untaken("SessionEventLogged")).toEqual([])
  })

  describe("with the GitHub App", () => {
    const keys = appKeyPair()
    let github: StandInGitHub

    beforeAll(() => {
      github = StandInGitHub.start(keys.publicKey)
    })
    afterAll(() => github.stop())

    const appHub = () => {
      github.reset()
      github.installedOn.add("kddige/kndl")
      return startHub({
        config: {
          devLogin: true,
          githubAppId: Option.some(appId),
          githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
          githubApiUrl: github.url,
        },
      })
    }

    /**
     * The Sandbox tokens minted, oldest first. The first token minted is the Hub's own for the
     * Repo, with which it asked how GitHub spells the Repo's name as the Session was created.
     */
    const sandboxTokens = () => github.mintedTokens.slice(1)

    test("Repo access is an installation token, with the App's bot as author", async () => {
      const { runner, sessionId } = await sessionScene(await appHub())
      const access = await ask(runner, sessionId, { _tag: "GitAccess" })

      expect(access).toMatchObject({
        _tag: "GitAccess",
        repo: "kddige/kndl",
        credentials: {
          _tag: "AppToken",
          token: github.mintedTokens[0],
          author: {
            name: `${appSlug}[bot]`,
            email: `${botUserId}+${appSlug}[bot]@users.noreply.github.com`,
          },
        },
      })
    })

    test("a Sandbox token is fresh for the Session, with every permission the installation has", async () => {
      const { runner, sessionId } = await sessionScene(await appHub())
      const answer = await ask(runner, sessionId, { _tag: "SandboxToken" })

      expect(answer).toMatchObject({ _tag: "SandboxToken", token: sandboxTokens()[0] })
      const mint = github.requests.findLast((request) => request.path.endsWith("/access_tokens"))
      expect(mint?.body).toEqual({ repositories: ["kndl"] })
      // A refresh is a new token.
      const again = await ask(runner, sessionId, { _tag: "SandboxToken" })
      expect((again as { token: string }).token).toBe(sandboxTokens()[1] ?? "")
      expect(sandboxTokens()[1]).not.toBe(sandboxTokens()[0])
    })

    test("a Sandbox token is redacted from the name of a process listening on a port (#175)", async () => {
      const { runner, web, sessionId } = await sessionScene(await appHub())
      await ask(runner, sessionId, { _tag: "SandboxToken" })
      const [token = ""] = sandboxTokens()

      runner.send({
        _tag: "SessionPorts",
        sessionId,
        ports: [{ port: 3000, addresses: ["0.0.0.0"], process: `node ${token}` }],
      })
      const listed = await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
      expect(listed.session.openPorts).toEqual([
        { port: 3000, addresses: ["0.0.0.0"], process: `node ${stars(token)}` },
      ])
    })

    test("the Session's current and previous Sandbox tokens are redacted from all it prints", async () => {
      const { runner, web, sessionId, mod } = await sessionScene(await appHub())
      joinSession(web, sessionId)
      await web.take("SessionHistory")
      web.send({ _tag: "OpenTerminal", sessionId })
      await runner.take("RequestTerminalSnapshot")

      await ask(runner, sessionId, { _tag: "SandboxToken" })
      await ask(runner, sessionId, { _tag: "SandboxToken" })
      const [previous = "", current = ""] = sandboxTokens()

      await mod.post(
        turnSaying("t-1", `push with ${current}`),
        {
          _tag: "ToolCallEnded",
          turnId: "t-1",
          toolCallId: "call-1",
          tool: "Bash",
          outcome: "Succeeded",
          output: `password=${previous}\n`,
        },
        turnEnded("t-1"),
      )
      runner.send({ _tag: "SandboxNote", sessionId, message: `bad token ${current}` })
      runner.send({
        _tag: "TerminalFrame",
        sessionId,
        kind: "Snapshot",
        data: `$ cat /run/kndl/github-token\r\n${current}\r\n$ `,
        size: { cols: 80, rows: 24 },
      })

      const logged = []
      for (let index = 0; index < 4; index++) {
        logged.push((await web.take("SessionEventLogged")).entry.event)
      }
      expect(logged).toMatchObject([
        { _tag: "TurnStarted", text: `push with ${stars(current)}` },
        { _tag: "ToolCallEnded", output: `password=${stars(previous)}\n` },
        { _tag: "TurnEnded" },
        { _tag: "SandboxNoted", message: `bad token ${stars(current)}` },
      ])
      expect((await web.take("TerminalFrame")).data).toBe(
        `$ cat /run/kndl/github-token\r\n${stars(current)}\r\n$ `,
      )
      for (const token of [previous, current]) {
        expect(web.texts.join("\n")).not.toContain(token)
      }
    })

    test("a token two refreshes old is no longer looked for", async () => {
      const { runner, web, sessionId, mod } = await sessionScene(await appHub())
      joinSession(web, sessionId)
      await web.take("SessionHistory")
      for (let index = 0; index < 3; index++) await ask(runner, sessionId, { _tag: "SandboxToken" })
      const [oldest = "", previous = ""] = sandboxTokens()

      await mod.post(turnSaying("t-1", `${oldest} ${previous}`))
      expect((await web.take("SessionEventLogged")).entry.event).toMatchObject({
        text: `${oldest} ${"*".repeat(previous.length)}`,
      })
    })
  })
})

/** A Session alice starts in `inRepo`. */
async function startIn(
  hub: TestHub,
  runner: Connection<ToRunner>,
  web: Connection<Web>,
  inRepo: string,
) {
  await seedEnvironment(hub, inRepo, "dev:alice")
  const requestId = `req-${inRepo}`
  web.send({
    _tag: "CreateSession",
    requestId,
    repo: inRepo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  await runner.take("StartSession", (start) => start.repo === inRepo)
  const created = await web.take("SessionCreated", (m) => m.requestId === requestId)
  return created.session.id
}

/** What the Hub says to a command about a Session that isn't there, or out of reach. */
const noSuchSession = (command: string, sessionId: string) => ({
  _tag: "CommandFailed" as const,
  command,
  sessionId,
  message: "There is no such Session.",
})

describe("Repo access", () => {
  const keys = appKeyPair()
  let github: StandInGitHub

  beforeAll(() => {
    github = StandInGitHub.start(keys.publicKey)
  })
  afterAll(() => github.stop())

  const repo = "kddige/kndl"
  const secret = "kddige/secret"
  const octocat = { id: "github:1", login: "octocat", name: "octocat" }
  const hubot = { id: "github:2", login: "hubot", name: "hubot" }

  /** A Hub with the GitHub App on `repo` and `secret`; alice, by dev login, has access to both. */
  const accessHub = (config: Partial<HubConfigInput> = {}) => {
    github.reset()
    github.installedOn.add(repo)
    github.installedOn.add(secret)
    return startHub({
      config: {
        devLogin: true,
        githubAppId: Option.some(appId),
        githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
        githubApiUrl: github.url,
        ...config,
      },
    })
  }

  /** A web client signed in with GitHub as `who`, with a setup token saved (ADR 0026). */
  async function openGitHubWeb(hub: TestHub, who: typeof octocat) {
    const { token } = await hub.run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        return yield* signIns.signIn(Participant.make({ ...who, id: ParticipantId.make(who.id) }))
      }),
    )
    await ensureSetupToken(hub, who.login, who.id)
    return openWeb(hub, who.login, `${signInCookie}=${token}`)
  }

  test("a person is sent only the Sessions of Repos they have access to", async () => {
    const { hub, runner, web, sessionId } = await sessionScene(await accessHub())
    const hidden = await startIn(hub, runner, web, secret)
    github.installedOn.add("kddige/later")
    github.grant(repo, "octocat")
    github.grant("kddige/later", "octocat")

    const octocatWeb = await openGitHubWeb(hub, octocat)
    const hubotWeb = await openGitHubWeb(hub, hubot)
    expect(octocatWeb.sessions.sessions.map((session) => session.id)).toEqual([sessionId])
    expect(hubotWeb.sessions.sessions).toEqual([])

    // And as they change, or a Repo gets its first Session.
    runner.send({ _tag: "SessionStarted", sessionId: hidden, environmentVersion: 1 })
    await web.take("SessionUpdated", (m) => m.session.id === hidden && !m.session.starting)
    web.send({ _tag: "ArchiveSession", sessionId })
    await octocatWeb.take("SessionUpdated", (m) => m.session.state === "Archived")
    const later = await startIn(hub, runner, web, "kddige/later")
    await octocatWeb.take("SessionUpdated", (m) => m.session.id === later)
    const updated = await octocatWeb.untaken("SessionUpdated")
    expect(updated.map((m) => m.session.id)).not.toContain(hidden)
    expect(await hubotWeb.untaken("SessionUpdated")).toEqual([])
  })

  test("every command about a Session out of reach is refused as if there were none", async () => {
    const { hub, runner, mod, sessionId } = await sessionScene(await accessHub())
    const hubotWeb = await openGitHubWeb(hub, hubot)
    await mod.poll()
    const commands = [
      { _tag: "JoinSession" },
      { _tag: "SendPrompt", text: "hi" },
      { _tag: "CancelPrompt", promptId: "p-1" },
      { _tag: "SteerPrompt", promptId: "p-1" },
      { _tag: "StopTurn" },
      { _tag: "MessageAgent", agentId: "a-1", text: "hi" },
      { _tag: "StopAgent", agentId: "a-1" },
      { _tag: "SleepSession" },
      { _tag: "WakeSession" },
      { _tag: "RestartSession" },
      { _tag: "ArchiveSession" },
      { _tag: "RestoreSession" },
      { _tag: "RenameSession", name: "mine now" },
      { _tag: "SetKeepAwake", on: true },
      { _tag: "OpenTerminal" },
      { _tag: "TerminalInput", data: "ls\r" },
      { _tag: "TerminalResize", size: { cols: 80, rows: 24 } },
    ]
    for (const command of commands) {
      for (const id of [sessionId, "no-such-session"]) {
        hubotWeb.send({ ...command, sessionId: id })
        expect(await hubotWeb.take("CommandFailed")).toEqual(noSuchSession(command._tag, id))
      }
    }

    // None reached the Session.
    expect(await mod.poll()).toEqual([])
    expect(await runner.untaken("RequestTerminalSnapshot")).toEqual([])
    expect(await runner.untaken("TerminalInput")).toEqual([])
    expect(await runner.untaken("StopSession")).toEqual([])
    expect(await hubotWeb.untaken("SessionHistory")).toEqual([])
  })

  test("an Archived Session out of reach can't be purged: it is no such Session (#351)", async () => {
    const scene = await sessionScene(await accessHub())
    const { hub, runner, sessionId } = scene
    await archived(scene)
    const hubotWeb = await openGitHubWeb(hub, hubot)
    for (const id of [sessionId, "no-such-session"]) {
      hubotWeb.send({ _tag: "PurgeArchivedSession", requestId: "r-purge", sessionId: id })
      expect(await hubotWeb.take("CommandFailed")).toEqual({
        ...noSuchSession("PurgeArchivedSession", id),
        requestId: "r-purge",
      })
    }
    expect(await runner.untaken("PurgeSession")).toEqual([])

    // octocat, granted the Repo, may, though he didn't create it.
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    octocatWeb.send({ _tag: "PurgeArchivedSession", requestId: "r-purge", sessionId })
    expect(await octocatWeb.take("ArchivedSessionPurged")).toMatchObject({ sessionId })
    expect(await runner.take("PurgeSession")).toEqual({ _tag: "PurgeSession", sessionId })
  })

  test("an Archived Session out of reach has no size to anyone without access to its Repo (#352)", async () => {
    const scene = await sessionScene(await accessHub(), { runnerHello: { measuresDisk: true } })
    const { hub, runner, sessionId } = scene
    await archived(scene)
    const hubotWeb = await openGitHubWeb(hub, hubot)
    hubotWeb.send({ _tag: "GetSessionDiskUsage", requestId: "r-size", sessionIds: [sessionId] })
    expect(await hubotWeb.take("SessionDiskUsage")).toEqual({
      _tag: "SessionDiskUsage",
      requestId: "r-size",
      sizes: [{ sessionId }],
    })
    expect(await runner.untaken("MeasureSessionDisks")).toEqual([])

    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    octocatWeb.send({ _tag: "GetSessionDiskUsage", requestId: "r-size", sessionIds: [sessionId] })
    const ask = await runner.take("MeasureSessionDisks")
    runner.send({
      _tag: "SessionDisksMeasured",
      requestId: ask.requestId,
      sizes: [{ sessionId, bytes: 9 }],
    })
    expect(await octocatWeb.take("SessionDiskUsage")).toMatchObject({
      sizes: [{ sessionId, bytes: 9 }],
    })
  })

  test("creating a Session needs access to its Repo", async () => {
    const { hub, runner } = await sessionScene(await accessHub())
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)

    for (const elsewhere of [secret, "kddige/not-installed"]) {
      octocatWeb.send({
        _tag: "CreateSession",
        requestId: "r",
        repo: elsewhere,
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
      })
      expect(await octocatWeb.take("CommandFailed")).toEqual({
        _tag: "CommandFailed",
        command: "CreateSession",
        requestId: "r",
        message: `You have no access to ${elsewhere} on GitHub, or the GitHub App isn't installed on it.`,
      })
    }
    octocatWeb.send({
      _tag: "CreateSession",
      requestId: "ok",
      repo,
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expect((await octocatWeb.take("SessionCreated")).session.creator).toMatchObject(octocat)
    // Its Creator commits in the Sandbox, by their GitHub noreply address.
    expect(
      (await runner.untaken("StartSession")).map((start) => ({
        repo: start.repo,
        gitIdentity: start.gitIdentity,
      })),
    ).toEqual([
      {
        repo,
        gitIdentity: { name: "octocat", email: "1+octocat@users.noreply.github.com" },
      },
    ])
  })

  test("lists the Repos the App is on that a person has access to (ADR 0023)", async () => {
    const hub = await accessHub()
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)

    octocatWeb.send({ _tag: "ListRepos", requestId: "l-1" })
    expect(await octocatWeb.take("ReposListed")).toEqual({
      _tag: "ReposListed",
      requestId: "l-1",
      repos: [repo],
    })
    // alice, by dev login, has access to every Repo.
    const aliceWeb = await openWeb(hub, "alice")
    aliceWeb.send({ _tag: "ListRepos", requestId: "l-2" })
    expect((await aliceWeb.take("ReposListed")).repos.toSorted()).toEqual([secret, repo].toSorted())
  })

  test("answers that listing is unavailable without the GitHub App, with the hint for a dev login only", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    web.send({ _tag: "ListRepos", requestId: "l-1" })
    expect(await web.take("ListingUnavailable")).toEqual({
      _tag: "ListingUnavailable",
      requestId: "l-1",
      hint: expect.stringContaining("GITHUB_APP_ID"),
    })
    web.send({ _tag: "ListBranches", requestId: "l-2", repo: "kddige/kndl" })
    expect(await web.take("ListingUnavailable")).toMatchObject({ requestId: "l-2" })
  })

  test("says nothing of GitHub's answer or the Hub's set-up when a listing fails", async () => {
    const hub = await accessHub()
    github.grant(repo, "octocat")
    github.installationsDown = true
    const octocatWeb = await openGitHubWeb(hub, octocat)

    octocatWeb.send({ _tag: "ListRepos", requestId: "l-1" })
    expect(await octocatWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "ListRepos",
      requestId: "l-1",
      message: "Could not list your Repos; try again.",
    })
    // No hint for someone signed in with GitHub, who can't act on it.
    const noApp = await startHub({ config: { devLogin: true } })
    const viaGitHub = await openGitHubWeb(noApp, octocat)
    viaGitHub.send({ _tag: "ListRepos", requestId: "l-2" })
    expect(await viaGitHub.take("ListingUnavailable")).toEqual({
      _tag: "ListingUnavailable",
      requestId: "l-2",
    })
  })

  test("keeps a person's list of Repos when a check finds no access they never had", async () => {
    const hub = await accessHub()
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    octocatWeb.send({ _tag: "ListRepos", requestId: "l-1" })
    expect((await octocatWeb.take("ReposListed")).repos).toEqual([repo])

    // A Repo they never had: the check says no, as the recheck does for each every so often.
    octocatWeb.send({ _tag: "CheckRepo", requestId: "c-1", repo: secret })
    expect((await octocatWeb.take("RepoChecked")).status).toBe("NoAccess")
    github.grant(secret, "octocat")
    octocatWeb.send({ _tag: "ListRepos", requestId: "l-2" })
    expect((await octocatWeb.take("ReposListed")).repos).toEqual([repo])
  })

  test("lists a Repo's branches to those with access to it, and to no one else", async () => {
    const hub = await accessHub()
    github.grant(repo, "octocat")
    github.branches.set(repo, { names: ["dev", "main"], defaultBranch: "main" })
    const octocatWeb = await openGitHubWeb(hub, octocat)

    octocatWeb.send({ _tag: "ListBranches", requestId: "b-1", repo })
    expect(await octocatWeb.take("BranchesListed")).toEqual({
      _tag: "BranchesListed",
      requestId: "b-1",
      repo,
      branches: ["dev", "main"],
      defaultBranch: "main",
    })
    octocatWeb.send({ _tag: "ListBranches", requestId: "b-2", repo: secret })
    expect(await octocatWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "ListBranches",
      requestId: "b-2",
      message: `You have no access to ${secret} on GitHub, or the GitHub App isn't installed on it.`,
    })
  })

  test("a collaborator can join and drive it, and GitHub is asked once", async () => {
    const { hub, runner, mod, sessionId } = await sessionScene(await accessHub())
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)

    joinSession(octocatWeb, sessionId)
    expect(await octocatWeb.take("SessionHistory")).toMatchObject({ sessionId })
    await octocatWeb.take("PresenceChanged")
    await mod.poll()
    // Everyone who sees it drives it, in the Pi Durable spike: it runs on alice's Models still.
    octocatWeb.send({ _tag: "SendPrompt", sessionId, text: "hi" })
    expect(await mod.deliveries(500)).toEqual([
      expect.objectContaining({
        text: "hi",
        sender: expect.objectContaining({ login: "octocat" }),
      }),
    ])
    octocatWeb.send({ _tag: "OpenTerminal", sessionId })
    expect(await runner.take("RequestTerminalSnapshot")).toEqual({
      _tag: "RequestTerminalSnapshot",
      sessionId,
    })
    expect(await octocatWeb.untaken("CommandFailed")).toEqual([])

    // As the list was made; the answer was cached for everything since.
    expect(github.collaboratorChecks("octocat")).toBe(1)
  })

  test("a cached answer stands until it expires, even after access is lost", async () => {
    // Rechecks are an hour apart.
    const { hub, sessionId } = await sessionScene(await accessHub({ repoAccessTtlMs: 3_600_000 }))
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    github.revoke(repo, "octocat")

    joinSession(octocatWeb, sessionId)
    expect(await octocatWeb.take("SessionHistory")).toMatchObject({ sessionId })
    expect(github.collaboratorChecks("octocat")).toBe(1)
  })

  test("a person who loses access is taken out of the Repo's Sessions, with presence updated", async () => {
    const { hub, runner, web, mod, sessionId } = await sessionScene(
      await accessHub({ repoAccessTtlMs: 100 }),
    )
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    joinSession(web, sessionId)
    await web.take("PresenceChanged")
    joinSession(octocatWeb, sessionId)
    await octocatWeb.take("SessionHistory")
    await web.take("PresenceChanged", (m) => m.participants.length === 2)
    web.send({ _tag: "OpenTerminal", sessionId })
    await runner.take("RequestTerminalSnapshot")

    github.revoke(repo, "octocat")
    expect(await octocatWeb.take("SessionRemoved")).toEqual({ _tag: "SessionRemoved", sessionId })
    expect((await web.take("PresenceChanged")).participants).toEqual([alice])
    const presence = (await mod.poll()).filter((command) => command._tag === "PresenceChanged")
    expect(presence.at(-1)).toMatchObject({ participants: [alice] })

    // Refused as if there were no such Session.
    const frame = {
      _tag: "TerminalFrame",
      sessionId,
      kind: "Output",
      data: "$ ",
      size: { cols: 80, rows: 24 },
    } as const
    runner.send(frame)
    expect(await web.take("TerminalFrame")).toEqual(frame)
    expect(await octocatWeb.untaken("TerminalFrame")).toEqual([])
    octocatWeb.send({ _tag: "SendPrompt", sessionId, text: "still here?" })
    expect(await octocatWeb.take("CommandFailed")).toEqual(noSuchSession("SendPrompt", sessionId))

    // Given back, the Session shows again.
    github.grant(repo, "octocat")
    expect((await octocatWeb.take("SessionUpdated")).session.id).toBe(sessionId)
  })

  test("when GitHub can't say, a person keeps what they had and no one new gets in", async () => {
    const { hub, sessionId } = await sessionScene(await accessHub({ repoAccessTtlMs: 100 }))
    github.grant(repo, "octocat")
    github.grant(repo, "hubot")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    joinSession(octocatWeb, sessionId)
    await octocatWeb.take("PresenceChanged")

    github.collaboratorsDown = true
    await Bun.sleep(300)
    // Still let in: he keeps what he had.
    octocatWeb.send({ _tag: "SendPrompt", sessionId, text: "hi" })
    await octocatWeb.take("PromptQueueChanged", (m) => m.queue.some((p) => p.text === "hi"))
    expect(await octocatWeb.untaken("CommandFailed")).toEqual([])
    expect(await octocatWeb.untaken("SessionRemoved")).toEqual([])

    const hubotWeb = await openGitHubWeb(hub, hubot)
    expect(hubotWeb.sessions.sessions).toEqual([])
    joinSession(hubotWeb, sessionId)
    expect((await hubotWeb.take("CommandFailed")).message).toBe(
      "Could not check your access on GitHub; try again.",
    )

    // Once GitHub answers again, at the next recheck.
    github.collaboratorsDown = false
    expect((await hubotWeb.take("SessionUpdated")).session.id).toBe(sessionId)
  })

  test("dev login has access to every Repo, and a dev sign-in none once it is off", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const devHub = await startHub({ config: { devLogin: true }, database })
      const { runner, web, sessionId } = await sessionScene(devHub)
      const other = await startIn(devHub, runner, web, secret)
      const bobWeb = await openWeb(devHub, "bob")
      expect(bobWeb.sessions.sessions.map((session) => session.id).toSorted()).toEqual(
        [sessionId, other].toSorted(),
      )
      await stopAll()

      const offHub = await startHub({ config: { devLogin: false }, database })
      const back = await openWeb(offHub, "alice", web.cookie)
      expect(back.sessions.sessions).toEqual([])
      joinSession(back, sessionId)
      expect(await back.take("CommandFailed")).toEqual(noSuchSession("JoinSession", sessionId))
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const agentStarted = (agentId: string, description = `Task ${agentId}`): ModEvent => ({
  _tag: "AgentStarted",
  turnId: "t-1",
  agentId,
  toolCallId: `call-${agentId}`,
  agentType: "general-purpose",
  description,
  model: "claude-haiku-4-5",
  background: true,
})

const agentStatus = (
  agentId: string,
  status: "Running" | "Done" | "Stopped" | "Interrupted",
): ModEvent => ({ _tag: "AgentStatusChanged", agentId, status })

/** The scene's Session after a Turn that started the background agent `a-1`, then ended. */
async function agentScene(hub?: TestHub) {
  const scene = await sessionScene(hub)
  joinSession(scene.web, scene.sessionId)
  await scene.web.take("SessionHistory")
  await scene.mod.post(
    turnStarted("t-1"),
    agentStarted("a-1"),
    agentStatus("a-1", "Running"),
    turnEnded("t-1"),
  )
  await scene.web.take("SessionUpdated", (m) => m.session.currentTurn === null)
  return scene
}

describe("subagents (ADR 0014)", () => {
  test("are logged and listed on their Session until they finish; an agent never seen start is dropped", async () => {
    const { web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post(turnStarted("t-1"), agentStarted("a-1", "Find the flaky test"))
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "AgentStarted")).entry
        .event,
    ).toMatchObject({ agentId: "a-1", toolCallId: "call-a-1", description: "Find the flaky test" })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.agents !== undefined)).session.agents,
    ).toEqual([{ id: "a-1", description: "Find the flaky test", status: "Running" }])

    const worktree = {
      path: "/workspace/.claude/worktrees/agent-a-1",
      branch: "worktree-agent-a-1",
    }
    await mod.post(agentStatus("a-9", "Done"), {
      _tag: "AgentStatusChanged",
      agentId: "a-1",
      status: "Done",
      worktree,
    })
    // Only a-1's: a-9 is none of the Session's.
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "AgentStatusChanged"))
        .entry.event,
    ).toEqual({ _tag: "AgentStatusChanged", agentId: "a-1", status: "Done", worktree })
    await web.take("SessionUpdated", (m) => m.session.agents === undefined)
    expect(
      (await web.untaken("SessionEventLogged")).filter(
        (m) => m.entry.event._tag === "AgentStatusChanged",
      ),
    ).toEqual([])
  })

  test("a Running agent keeps its Session awake after its Turn ended, until it is done", async () => {
    const { runner, web, sessionId, mod } = await agentScene(await hubSleepingAfter(150))
    web.send({ _tag: "LeaveSession", sessionId })
    await Bun.sleep(250)
    expect(await runner.untaken("StopSession")).toEqual([])

    await mod.post(agentStatus("a-1", "Done"))
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
  })

  test("its Running agents are Interrupted when its Claude Code stops", async () => {
    const scene = await agentScene()
    const { web, mod } = scene
    await mod.post(agentStarted("a-2"), agentStatus("a-2", "Done"))
    await web.take("SessionUpdated", (m) => m.session.agents?.length === 1)
    await asleep(scene)

    const interrupted = await web.take(
      "SessionEventLogged",
      (m) => m.entry.event._tag === "AgentStatusChanged" && m.entry.event.status === "Interrupted",
    )
    expect(interrupted.entry.event).toEqual({
      _tag: "AgentStatusChanged",
      agentId: "a-1",
      status: "Interrupted",
    })
    const [session] = (await openWeb(scene.hub, "bob")).sessions.sessions
    expect(session?.agents).toEqual([{ id: "a-1", description: "Task a-1", status: "Interrupted" }])
  })

  test("its Creator can message an agent: logged, sent to the mod, waking an Asleep Session", async () => {
    const scene = await agentScene()
    const { hub, runner, web, sessionId, mod } = scene
    await mod.poll()
    web.send({ _tag: "MessageAgent", sessionId, agentId: "a-1", text: "Check the docs too" })
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "AgentMessaged")).entry
        .event,
    ).toEqual({ _tag: "AgentMessaged", agentId: "a-1", sender: alice, text: "Check the docs too" })
    expect(await mod.poll(500)).toEqual([
      {
        _tag: "DeliverAgentMessage",
        sessionId,
        agentId: "a-1",
        text: "Check the docs too",
        sender: alice,
      },
    ])

    // Asleep, its agent Interrupted: a message wakes the Session, and its new mod resumes it.
    await asleep(scene)
    web.send({ _tag: "MessageAgent", sessionId, agentId: "a-1", text: "Carry on" })
    const wake = await runner.take("StartSession")
    expect(wake).toMatchObject({ sessionId, resume: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f" })
    runner.send({ _tag: "SessionStarted", sessionId })
    const woken = new Mod(hub, sessionId, wake.modToken)
    expect((await woken.hello()).status).toBe(200)
    expect(await woken.next("DeliverAgentMessage", 500)).toContainEqual({
      _tag: "DeliverAgentMessage",
      sessionId,
      agentId: "a-1",
      text: "Carry on",
      sender: alice,
    })
  })

  test("a Running agent can be stopped; a mod that can't do either tells whoever asked", async () => {
    const { hub, web, sessionId, mod } = await agentScene()
    const bobWeb = await openWeb(hub, "bob")
    await mod.poll()
    web.send({ _tag: "StopAgent", sessionId, agentId: "a-1" })
    expect(await mod.poll(500)).toEqual([{ _tag: "StopAgent", sessionId, agentId: "a-1" }])

    // A failed message goes to its sender; a failed stop to everyone in the Session.
    await mod.post({
      _tag: "AgentCommandFailed",
      agentId: "a-1",
      command: "MessageAgent",
      senderId: bob.id,
      message: "no such agent",
    })
    expect(await bobWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "MessageAgent",
      sessionId,
      message: "Your message could not be delivered to the agent: no such agent",
    })
    await mod.post({
      _tag: "AgentCommandFailed",
      agentId: "a-1",
      command: "StopAgent",
      message: "TaskStop failed",
    })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "StopAgent",
      sessionId,
      message: "The agent could not be stopped: TaskStop failed",
    })
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
  })

  test("messaging or stopping an agent is refused when it can't reach it", async () => {
    const scene = await agentScene()
    const { web, sessionId, mod } = scene
    await mod.post(agentStatus("a-1", "Done"))
    await web.take("SessionUpdated", (m) => m.session.agents === undefined)
    await mod.poll()
    const refusals = [
      [{ _tag: "MessageAgent", agentId: "a-9", text: "hi" }, "The Session has no such agent."],
      [{ _tag: "StopAgent", agentId: "a-9" }, "The Session has no such agent."],
      [{ _tag: "StopAgent", agentId: "a-1" }, "The agent isn't running."],
    ] as const
    for (const [command, message] of refusals) {
      web.send({ ...command, sessionId })
      expect(await web.take("CommandFailed")).toEqual({
        _tag: "CommandFailed",
        command: command._tag,
        sessionId,
        message,
      })
    }
    expect(await mod.poll()).toEqual([])
    web.send({ _tag: "ArchiveSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Archived")
    web.send({ _tag: "MessageAgent", sessionId, agentId: "a-1", text: "hi" })
    expect(await web.take("CommandFailed")).toMatchObject({
      command: "MessageAgent",
      message: "The Session is archived: restore it to message agents.",
    })
  })
})

const closed = (m: Extract<Web, { _tag: "SessionEventLogged" }>) =>
  m.entry.event._tag === "QuestionClosed"

describe("Open questions (#193)", () => {
  const library = "Which date library?"
  const questionAsked = (turnId = "t-1", toolCallId = "toolu_ask"): ModEvent => ({
    _tag: "QuestionAsked",
    turnId,
    toolCallId,
    questions: [
      {
        question: library,
        header: "Library",
        options: [{ label: "date-fns", description: "Small" }, { label: "Temporal" }],
        multiSelect: false,
      },
    ],
  })
  type Updated = Extract<Web, { _tag: "SessionUpdated" }>
  const hasQuestion = (m: Updated) => m.session.openQuestion !== undefined
  const noQuestion = (m: Updated) => m.session.openQuestion === undefined

  /** A Session whose Turn t-1 asks a question, with alice and bob in it. */
  async function questionScene() {
    const scene = await sessionScene()
    const { hub, web, sessionId, mod } = scene
    const bobWeb = await openWeb(hub, "bob")
    for (const client of [web, bobWeb]) {
      joinSession(client, sessionId)
      await client.take("SessionHistory")
    }
    await mod.poll()
    await mod.post(turnStarted("t-1"), questionAsked())
    const asked = await bobWeb.take("SessionUpdated", hasQuestion)
    return { ...scene, bobWeb, asked }
  }

  test("is the Session's until answered from the web, which the mod is sent", async () => {
    const { hub, web, bobWeb, sessionId, mod, asked } = await questionScene()
    expect(asked.session.openQuestion).toMatchObject({
      turnId: "t-1",
      toolCallId: "toolu_ask",
      questions: [{ question: library, options: [{ label: "date-fns" }, { label: "Temporal" }] }],
    })
    const logged = await web.take(
      "SessionEventLogged",
      (m) => m.entry.event._tag === "QuestionAsked",
    )
    expect(logged.entry.event).toMatchObject({ toolCallId: "toolu_ask" })
    // A client that connects later, as after a reload, sees it with the Session.
    const later = await openWeb(hub, "alice", web.cookie)
    expect(later.sessions.sessions).toEqual([
      expect.objectContaining({ id: sessionId, openQuestion: asked.session.openQuestion }),
    ])

    const answer = { _tag: "Answered", answers: { [library]: "Temporal" } } as const
    web.send({ _tag: "AnswerQuestion", sessionId, toolCallId: "toolu_ask", answer })
    expect(await mod.poll(500)).toEqual([
      { _tag: "DeliverAnswer", sessionId, toolCallId: "toolu_ask", answer, sender: alice },
    ])
    const outcome: ModEvent = {
      _tag: "QuestionClosed",
      turnId: "t-1",
      toolCallId: "toolu_ask",
      outcome: answer,
      by: alice,
    }
    await mod.post(outcome)
    await bobWeb.take("SessionUpdated", noQuestion)
    expect((await bobWeb.take("SessionEventLogged", closed)).entry.event).toEqual(outcome)

    // Too late, from her other tab: she is told who answered first, and what, and the mod is
    // sent nothing.
    later.send({ _tag: "AnswerQuestion", sessionId, toolCallId: "toolu_ask", answer })
    expect(await later.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "AnswerQuestion",
      sessionId,
      message: "alice answered first: Temporal.",
    })
    expect(await mod.poll()).toEqual([])
  })

  test("an answer the mod got after another is refused, saying who answered first", async () => {
    const { hub, web, bobWeb, sessionId, mod } = await questionScene()
    const tab = await openWeb(hub, "alice", web.cookie)
    web.send({
      _tag: "AnswerQuestion",
      sessionId,
      toolCallId: "toolu_ask",
      answer: { _tag: "Dismissed" },
    })
    tab.send({
      _tag: "AnswerQuestion",
      sessionId,
      toolCallId: "toolu_ask",
      answer: { _tag: "Replied", text: "Use the platform" },
    })
    const commands = await mod.poll(500)
    if (commands.length < 2) commands.push(...(await mod.poll(500)))
    expect(commands.map((command) => command._tag)).toEqual(["DeliverAnswer", "DeliverAnswer"])
    await mod.post(
      {
        _tag: "QuestionClosed",
        turnId: "t-1",
        toolCallId: "toolu_ask",
        outcome: { _tag: "Dismissed" },
        by: alice,
      },
      { _tag: "AnswerFailed", toolCallId: "toolu_ask", senderId: alice.id, message: "closed" },
    )
    expect(await tab.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "AnswerQuestion",
      sessionId,
      message: "alice dismissed the question first.",
    })
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])

    // One the Hub knows nothing of says only that it came too late.
    await mod.post({
      _tag: "AnswerFailed",
      toolCallId: "toolu_other",
      senderId: alice.id,
      message: "No question is waiting on this answer.",
    })
    expect((await tab.take("CommandFailed")).message).toBe(
      "Your answer came too late: No question is waiting on this answer.",
    )
  })

  test("picks are shown to everyone in the Session, and to those who join, until it closes", async () => {
    const { hub, web, bobWeb, sessionId, mod } = await questionScene()
    const pick = (answer: string, toolCallId = "toolu_ask") =>
      web.send({ _tag: "PickAnswer", sessionId, toolCallId, question: library, answer })
    pick("date-fns")
    expect(await bobWeb.take("QuestionPicks")).toEqual({
      _tag: "QuestionPicks",
      sessionId,
      toolCallId: "toolu_ask",
      picks: [{ participant: alice, question: library, answer: "date-fns" }],
    })
    pick("Temporal")
    await bobWeb.take("QuestionPicks", (m) => m.picks[0]?.answer === "Temporal")
    const another = await openWeb(hub, "carol")
    joinSession(another, sessionId)
    expect((await another.take("QuestionPicks")).picks).toEqual([
      { participant: alice, question: library, answer: "Temporal" },
    ])
    pick("")
    await bobWeb.take("QuestionPicks", (m) => m.picks.length === 0)

    // A pick for another question, or once it has closed, is moot.
    pick("date-fns", "toolu_other")
    await mod.post(turnEnded("t-1"))
    await bobWeb.take("SessionUpdated", noQuestion)
    pick("date-fns")
    await Bun.sleep(100)
    expect(await bobWeb.untaken("QuestionPicks")).toEqual([])
  })

  test("is Cancelled when its Turn ends or its Claude Code stops first", async () => {
    const scene = await questionScene()
    const { web, sessionId, mod } = scene
    await mod.post(turnEnded("t-1"))
    await web.take("SessionUpdated", noQuestion)
    expect((await web.take("SessionEventLogged", closed)).entry.event).toEqual({
      _tag: "QuestionClosed",
      turnId: "t-1",
      toolCallId: "toolu_ask",
      outcome: { _tag: "Cancelled" },
    })
    // The mod's own close, after, changes nothing.
    await mod.post({
      _tag: "QuestionClosed",
      turnId: "t-1",
      toolCallId: "toolu_ask",
      outcome: { _tag: "Cancelled" },
    })
    web.send({
      _tag: "AnswerQuestion",
      sessionId,
      toolCallId: "toolu_ask",
      answer: { _tag: "Dismissed" },
    })
    expect((await web.take("CommandFailed")).message).toBe("The question was cancelled first.")
    expect((await web.untaken("SessionEventLogged")).filter(closed)).toEqual([])

    await mod.post(turnStarted("t-2"), questionAsked("t-2", "toolu_again"))
    await web.take("SessionUpdated", hasQuestion)
    scene.runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })
    const stopped = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(stopped.session.openQuestion).toBeUndefined()
    expect((await web.take("SessionEventLogged", closed)).entry.event).toMatchObject({
      toolCallId: "toolu_again",
      outcome: { _tag: "Cancelled" },
    })
  })

  test("one asked async stays open when its Turn ends, and the mod is sent its answer after", async () => {
    const { web, sessionId, mod } = await questionScene()
    await mod.post({ ...questionAsked("t-1", "toolu_async"), async: true } as ModEvent)
    const asked = await web.take("SessionUpdated", (m) => m.session.openQuestion?.async === true)
    expect(asked.session.openQuestion).toMatchObject({ toolCallId: "toolu_async", async: true })

    await mod.post(turnEnded("t-1"))
    // Its Turn ended, and the question is still open.
    const ended = await web.take(
      "SessionUpdated",
      (m) => m.session.currentTurn === null && m.session.openQuestion?.async === true,
    )
    expect(ended.session.openQuestion).toMatchObject({ toolCallId: "toolu_async", async: true })
    const logged = (await web.untaken("SessionEventLogged")).filter(closed)
    expect(logged.map((m) => m.entry.event)).toEqual([
      expect.objectContaining({ toolCallId: "toolu_ask", outcome: { _tag: "Cancelled" } }),
    ])

    const answer = { _tag: "Answered", answers: { [library]: "Temporal" } } as const
    web.send({ _tag: "AnswerQuestion", sessionId, toolCallId: "toolu_async", answer })
    expect(await mod.poll(500)).toEqual([
      { _tag: "DeliverAnswer", sessionId, toolCallId: "toolu_async", answer, sender: alice },
    ])
    await mod.post({
      _tag: "QuestionClosed",
      turnId: "t-1",
      toolCallId: "toolu_async",
      outcome: answer,
      by: alice,
    })
    await web.take("SessionUpdated", noQuestion)
  })

  test("a new question closes one left open, and an archived Session has none", async () => {
    const { web, sessionId, mod } = await questionScene()
    await mod.post(questionAsked("t-1", "toolu_next"))
    expect((await web.take("SessionEventLogged", closed)).entry.event).toMatchObject({
      toolCallId: "toolu_ask",
      outcome: { _tag: "Cancelled" },
    })
    const next = await web.take(
      "SessionUpdated",
      (m) => m.session.openQuestion?.toolCallId === "toolu_next",
    )
    expect(next.session.openQuestion?.turnId).toBe("t-1")

    web.send({ _tag: "ArchiveSession", sessionId })
    const gone = await web.take("SessionUpdated", (m) => m.session.state === "Archived")
    expect(gone.session.openQuestion).toBeUndefined()
  })

  test("an answer to a question that was never asked is refused, and the mod sent nothing", async () => {
    const { web, sessionId, mod } = await sessionScene()
    await mod.poll()
    web.send({
      _tag: "AnswerQuestion",
      sessionId,
      toolCallId: "toolu_nothing",
      answer: { _tag: "Dismissed" },
    })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "AnswerQuestion",
      sessionId,
      message: "The question is no longer open.",
    })
    expect(await mod.poll()).toEqual([])
  })

  test("keeps an otherwise idle Session awake", async () => {
    const scene = await sessionScene(await hubSleepingAfter(150))
    const { runner, mod } = scene
    // As though its Turn's end were lost: the question alone holds it up.
    await mod.post(questionAsked())
    await Bun.sleep(250)
    expect(await runner.untaken("StopSession")).toEqual([])
  })

  test("outlives a Hub restart", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: { devLogin: true }, database })
      const { runner, web, sessionId, mod } = await sessionScene(first)
      await mod.post(turnStarted("t-1"), questionAsked())
      const asked = await web.take("SessionUpdated", hasQuestion)
      await web.close()
      await runner.close()
      await first.stop()

      const second = await startHub({ config: { devLogin: true }, database })
      const back = await openWeb(second, "alice", web.cookie)
      expect(back.sessions.sessions).toEqual([
        expect.objectContaining({ id: sessionId, openQuestion: asked.session.openQuestion }),
      ])
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a Session's live state ending (#243)", () => {
  test("a Runner's new connection settles a stop its old one was asked for", async () => {
    const { hub, runner, runnerToken, web, sessionId, mod } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "SleepSession", sessionId })
    await runner.take("StopSession")

    // It restarts before it answers, its Claude Code still running in tmux: the new connection
    // replaces the old one.
    const back = await openRunner(hub, runnerToken, [sessionId])
    expect((await runner.closed).code).toBe(4409)
    web.send({ _tag: "SendPrompt", sessionId, text: "still there?" })
    const [delivered] = await mod.deliveries(500)
    expect(defined(delivered).text).toBe("still there?")
    await mod.post(
      turnStarted("t-1", defined(delivered).promptId, {
        _tag: "FromParticipant",
        participant: alice,
      }),
      turnEnded("t-1"),
    )

    // Asked again, it is stopped again.
    web.send({ _tag: "SleepSession", sessionId })
    expect(await back.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
  })

  test("archiving drops a steer under way and the Open ports, so a restore isn't held up by them", async () => {
    const { hub, runner, runnerToken, web, sessionId, mod } = await sessionScene()
    expect((await mod.hello({ steers: true })).status).toBe(200)
    await mod.post(turnStarted("t-0"))
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    const ports = [{ port: 3000, addresses: ["0.0.0.0"], process: "node server" }]
    runner.send({ _tag: "SessionPorts", sessionId, ports })
    await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    const [one] = (await web.take("PromptQueueChanged", queueIs("one"))).queue
    web.send({ _tag: "SteerPrompt", sessionId, promptId: defined(one).id })
    expect(await steers(mod, 500)).toHaveLength(1)

    // Archived, and its Runner gone before it stopped it; restored while it is away.
    web.send({ _tag: "ArchiveSession", sessionId })
    await runner.take("StopSession")
    await web.take("SessionUpdated", (m) => m.session.state === "Archived")
    await runner.close()
    web.send({ _tag: "RestoreSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")

    // It comes back from a restart with Claude Code still running, and no Open ports said yet.
    const back = await openRunner(hub, runnerToken, [sessionId], undefined, true, {
      withoutModToken: [sessionId],
    })
    const reissued = await back.take("ModTokenReissued")
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    const renewed = new Mod(hub, sessionId, reissued.modToken)
    expect((await renewed.hello({ steers: true })).status).toBe(200)
    await renewed.post(turnEnded("t-0"))
    expect((await renewed.deliveries(500)).map((command) => command.text)).toEqual(["one"])
    const later = await openWeb(hub, "alice")
    expect(later.sessions.sessions.find((s) => s.id === sessionId)?.openPorts).toBeUndefined()
  })

  test("a prompt in flight and a steer under way outlive a Runner restart that Claude Code outlives", async () => {
    const { hub, runner, runnerToken, web, sessionId, mod } = await sessionScene()
    expect((await mod.hello({ steers: true })).status).toBe(200)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    const [delivered] = await mod.deliveries(500)
    const sender = { _tag: "FromParticipant", participant: alice } as const

    // The Runner restarts with the prompt on its way; the mod talks to the Hub on its own.
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    const again = await openRunner(hub, runnerToken, [sessionId])
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    // Delivered once: it is still in flight, and starts its Turn.
    expect(await mod.deliveries(50)).toEqual([])
    await mod.post(turnStarted("t-1", defined(delivered).promptId, sender))
    await web.take("PromptQueueChanged", queueIs())

    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    web.send({ _tag: "SendPrompt", sessionId, text: "three" })
    const [two] = (await web.take("PromptQueueChanged", queueIs("two", "three"))).queue
    // The mod still steers: it said so in the hello before the restart.
    web.send({ _tag: "SteerPrompt", sessionId, promptId: defined(two).id })
    expect(await steers(mod, 500)).toHaveLength(1)

    // It restarts again with the steer on its way: nothing goes until the mod answers it.
    await again.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    await openRunner(hub, runnerToken, [sessionId])
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    await mod.post(turnEnded("t-1"))
    expect(await mod.deliveries(50)).toEqual([])
    await mod.post({
      _tag: "PromptSteered",
      turnId: "t-1",
      promptId: defined(two).id,
      text: "two",
      sender: alice,
    })
    expect((await mod.deliveries(500)).map((command) => command.text)).toEqual(["three"])
  })
})

/** Makes the Hub's database refuse to record a Runner's hello, until the returned undo. */
const refuseHellos = async (hub: TestHub) => {
  await hub.run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`CREATE TRIGGER refuse_hello BEFORE UPDATE OF version_commit ON runners
            BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
    ),
  )
  return () => hub.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP TRIGGER refuse_hello`))
}

describe("connections (#243)", () => {
  test("a Runner whose connection fails part way through isn't left online", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const { token } = await issueRunnerToken(hub)
    const undo = await refuseHellos(hub)
    // Welcomed, maybe, before its hello fails to be recorded: either way the connection closes.
    const runner = await Connection.open<ToRunner>(hub, "/ws/runner", bearer(token), {
      _tag: "RunnerHello",
      protocolVersion: ProtocolVersion,
      name: "mac",
      sessions: [],
    })
    await runner.closed
    await undo()

    const web = await openWeb(hub, "alice")
    expect(web.runners.runners.map((known) => known.isOnline)).toEqual([false])
    // Its Sessions can't be sent to it either.
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "req-1",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expect((await web.take("CommandFailed")).command).toBe("CreateSession")
  })
})

describe("driving (ADR 0026, lifted in the Pi Durable spike)", () => {
  test("anyone who sees a Session prompts it, stops its Turn and uses its terminal, on its Creator's accounts", async () => {
    const { hub, runner, sessionId, mod } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    expect(await bobWeb.take("SessionHistory")).toMatchObject({ sessionId })
    await mod.poll()

    bobWeb.send({ _tag: "SendPrompt", sessionId, text: "hi from bob" })
    const [prompt] = await mod.deliveries(500)
    expect(prompt).toMatchObject({ text: "hi from bob", sender: bob })
    await mod.post(
      turnStarted("t-1", defined(prompt).promptId, { _tag: "FromParticipant", participant: bob }),
    )
    await bobWeb.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")
    bobWeb.send({ _tag: "StopTurn", sessionId })
    expect(
      (await bobWeb.take("SessionEventLogged", (m) => m.entry.event._tag === "TurnStopRequested"))
        .entry.event,
    ).toEqual({ _tag: "TurnStopRequested", by: bob })
    expect(await mod.next("StopTurn", 500)).toEqual([{ _tag: "StopTurn", sessionId }])

    bobWeb.send({ _tag: "OpenTerminal", sessionId })
    expect(await runner.take("RequestTerminalSnapshot")).toEqual({
      _tag: "RequestTerminalSnapshot",
      sessionId,
    })
    bobWeb.send({ _tag: "TerminalInput", sessionId, data: "ls\r" })
    expect(await runner.take("TerminalInput")).toEqual({
      _tag: "TerminalInput",
      sessionId,
      data: "ls\r",
    })
    bobWeb.send({ _tag: "TerminalResize", sessionId, size: { cols: 100, rows: 30 } })
    expect(await runner.take("TerminalResize")).toMatchObject({ size: { cols: 100, rows: 30 } })
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
    // It still runs on alice's: the Session is hers.
    expect((await openWeb(hub, "carol")).sessions.sessions[0]?.creator).toEqual(alice)
  })

  test("a Session's terminal frames go to every connection that opened it", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")
    const carolWeb = await openWeb(hub, "carol")
    joinSession(bobWeb, sessionId)
    await bobWeb.take("SessionHistory")
    const tab = await openWeb(hub, "alice", web.cookie)
    for (const client of [web, tab, bobWeb]) client.send({ _tag: "OpenTerminal", sessionId })
    for (let i = 0; i < 3; i++) await runner.take("RequestTerminalSnapshot")

    for (const kind of ["Snapshot", "Output"] as const) {
      const frame = {
        _tag: "TerminalFrame",
        sessionId,
        kind,
        data: "$ ",
        size: { cols: 80, rows: 24 },
      } as const
      runner.send(frame)
      for (const client of [web, tab, bobWeb]) {
        expect(await client.take("TerminalFrame")).toEqual(frame)
      }
    }
    // Only to those who opened it.
    expect(await carolWeb.untaken("TerminalFrame")).toEqual([])
  })
})

describe("revoking a Claude credential (ADR 0026)", () => {
  test("removing it puts its owner's Active Sessions to sleep, mid-Turn, saying why", async () => {
    const { hub, runner, web, sessionId, mod } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")
    joinSession(bobWeb, sessionId)
    await bobWeb.take("SessionHistory")
    await mod.post(turnStarted("t-1"))

    web.send({ _tag: "RemoveClaudeCredential", requestId: "rm" })
    expect(await runner.take("StopSession")).toEqual({
      _tag: "StopSession",
      sessionId,
      reason: "Sleep",
    })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect((await bobWeb.take("SessionEventLogged", stateChanged("Asleep"))).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      by: alice,
      message: "Put to sleep: the Claude credential it ran on was removed",
    })

    // It doesn't wake without one.
    web.send({ _tag: "WakeSession", sessionId })
    expect(
      (await bobWeb.take("SessionEventLogged", stateChanged("Asleep"))).entry.event,
    ).toMatchObject({
      message:
        "The agent could not start: You have no Models to run a Session on: connect a Provider on the Account page.",
    })
    expect(await runner.untaken("StartSession")).toEqual([])
  })

  test("replacing it puts them to sleep, to wake on the new one", async () => {
    const { runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    const replacement = "sk-ant-oat01-ANOTHER_FAKE_TOKEN_FOR_TESTS_0000"

    web.send({ _tag: "SetClaudeCredential", requestId: "new", secret: replacement })
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect((await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      by: alice,
      message: "Put to sleep, to wake on a new Claude credential: the one it ran on was replaced",
    })

    web.send({ _tag: "WakeSession", sessionId })
    await runner.take("StartSession")
    runner.send({ _tag: "FetchClaudeCredential", requestId: "f", sessionId })
    expect(await runner.take("ClaudeCredentialFetched")).toEqual({
      _tag: "ClaudeCredentialFetched",
      requestId: "f",
      credential: { _tag: "OAuthToken", token: replacement },
    })
  })

  test("one revoked while its Runner is offline goes to sleep when it is back", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "SetClaudeCredential", requestId: "new", secret: setupTokenOf("alice-2") })
    await web.take("ClaudeCredentialState", (m) => m.requestId === "new")

    // Claude Code kept running on the one before, in tmux.
    const back = await openRunner(hub, runnerToken, [sessionId])
    expect(await back.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
    back.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect(
      (await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event,
    ).toMatchObject({
      by: alice,
      message: "Put to sleep, to wake on a new Claude credential: the one it ran on was replaced",
    })
    expect(await back.untaken("StartSession")).toEqual([])
  })

  test("removing its owner as a Member puts their Sessions to sleep, saying who did", async () => {
    const { hub, runner, web, sessionId } = await sessionScene()
    // bob is the Hub's Owner, who alone removes Members.
    const bobWeb = await openWeb(hub, "bob")
    await hub.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE participants SET owner = 1 WHERE id = 'dev:bob'`,
      ),
    )
    joinSession(bobWeb, sessionId)
    await bobWeb.take("SessionHistory")

    bobWeb.send({ _tag: "RemoveMember", requestId: "rm", participantId: "dev:alice" })
    await web.closed
    expect(await runner.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    expect((await bobWeb.take("SessionEventLogged", stateChanged("Asleep"))).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      by: bob,
      message: "Put to sleep: alice, who started it, was removed from the Hub",
    })
    // Its Runner isn't handed their credential.
    runner.send({ _tag: "FetchClaudeCredential", requestId: "f", sessionId })
    expect(await runner.take("ClaudeCredentialRefused")).toMatchObject({
      message: "alice, who started this Session, isn't a Member of this Hub any more.",
    })
  })

  test("the Creator's setup token is masked in its transcript, terminal and last output", async () => {
    const { runner, web, sessionId, mod } = await sessionScene()
    const token = setupTokenOf("alice")
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "OpenTerminal", sessionId })
    await runner.take("RequestTerminalSnapshot")

    await mod.post(turnSaying("t-1", `echo $CLAUDE_CODE_OAUTH_TOKEN: ${token}`))
    expect((await web.take("SessionEventLogged")).entry.event).toMatchObject({
      _tag: "TurnStarted",
      text: `echo $CLAUDE_CODE_OAUTH_TOKEN: ${stars(token)}`,
    })
    runner.send({
      _tag: "TerminalFrame",
      sessionId,
      kind: "Snapshot",
      data: `$ env\r\nCLAUDE_CODE_OAUTH_TOKEN=${token}\r\n`,
      size: { cols: 120, rows: 40 },
    })
    expect((await web.take("TerminalFrame")).data).toBe(
      `$ env\r\nCLAUDE_CODE_OAUTH_TOKEN=${stars(token)}\r\n`,
    )
    runner.send({
      _tag: "SessionStopped",
      sessionId,
      reason: "Exited",
      exitCode: 1,
      output: `bad token ${token}`,
    })
    const slept = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(slept.session.lastOutput).toBe(`bad token ${stars(token)}`)
    expect(web.texts.join("\n")).not.toContain(token)
  })
})

describe("a Hub starting (the Pi Durable spike)", () => {
  test("keeps everyone's queued prompts, and a Session with nothing to run on sleeps", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: { devLogin: true }, database })
      const { runner, runnerToken, web, sessionId, mod } = await sessionScene(first)
      const bobWeb = await openWeb(first, "bob")
      await mod.post(turnStarted("t-1"))
      joinSession(web, sessionId)
      web.send({ _tag: "SendPrompt", sessionId, text: "mine" })
      await web.take("PromptQueueChanged", queueIs("mine"))
      bobWeb.send({ _tag: "SendPrompt", sessionId, text: "bob's" })
      await web.take("PromptQueueChanged", queueIs("mine", "bob's"))
      // alice's credential, which her Claude Models came with, is gone.
      await first.run(
        Effect.flatMap(ClaudeCredentials, (credentials) =>
          credentials.remove(ParticipantId.make(alice.id)),
        ),
      )
      await web.close()
      await runner.close()
      await first.stop()

      const second = await startHub({ config: { devLogin: true }, database })
      const back = await openWeb(second, "alice", web.cookie)
      joinSession(back, sessionId)
      const history = await back.take("SessionHistory")
      expect(history.entries.filter((entry) => entry.event._tag === "PromptCancelled")).toEqual([])
      expect(queueTexts(await back.take("PromptQueueChanged"))).toEqual(["mine", "bob's"])

      // Its agent kept running in tmux, on Models that are gone.
      const again = await openRunner(second, runnerToken, [sessionId])
      expect(await again.take("StopSession")).toMatchObject({ sessionId, reason: "Sleep" })
      again.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
      expect((await back.take("SessionEventLogged", stateChanged("Asleep"))).entry.event).toEqual({
        _tag: "SessionStateChanged",
        state: "Asleep",
        message: "Put to sleep: it runs on the Models of alice, who started it, and they have none",
      })
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Threads (docs/design/durable-harness.md) ──────────────────────────────

/** Matches a TextDelta of the Turn `turnId` logged. */
const deltaOf = (turnId: string) => (m: Extract<Web, { _tag: "SessionEventLogged" }>) =>
  m.entry.event._tag === "TextDelta" && m.entry.event.turnId === turnId

type ThreadSummaryOf = NonNullable<Extract<Web, { _tag: "SessionUpdated" }>["session"]["threads"]>

/** The Session's threads, as the SessionUpdated a client took says. */
const threadsOf = (m: Extract<Web, { _tag: "SessionUpdated" }>): ThreadSummaryOf =>
  m.session.threads ?? []

const loggedTag =
  (tag: string) =>
  (m: Extract<Web, { _tag: "SessionEventLogged" }>): boolean =>
    m.entry.event._tag === tag

/**
 * A durable agent's Session after a main-loop Turn `t-1`, which alice and bob both joined, on a Hub
 * where alice has `models`.
 */
async function threadScene(
  models: ReadonlyArray<TestModel> = [gpt, claudeOpus],
  database?: Layer.Layer<SqlClient.SqlClient, unknown>,
) {
  const { hub, catalogue } = await piHub(models, database)
  const scene = await sessionScene(hub, piSession)
  const { web, sessionId, mod } = scene
  expect((await mod.hello({ durable: true, switchesModels: true })).status).toBe(200)
  joinSession(web, sessionId)
  await web.take("SessionHistory")
  const bobWeb = await openWeb(hub, "bob")
  joinSession(bobWeb, sessionId)
  await bobWeb.take("SessionHistory")
  await mod.post(...answered("t-1", "Add a health check", "Added /health."))
  await bobWeb.take("SessionEventLogged", turnEndedLogged("t-1"))
  await mod.poll()
  return { ...scene, catalogue, bobWeb }
}

let requests = 0
/** A web command's request id, as the web client numbers its own. */
const request = () => `req-${++requests}`

/** Bob starts a thread off `t-1`: its id, from the ThreadCreated he is sent. */
async function bobStartsThread(
  scene: Awaited<ReturnType<typeof threadScene>>,
  more: Record<string, unknown> = {},
) {
  scene.bobWeb.send({
    _tag: "CreateThread",
    requestId: request(),
    sessionId: scene.sessionId,
    anchorTurnId: "t-1",
    text: "what about Windows?\nAnd macOS.",
    ...more,
  })
  return (await scene.bobWeb.take("ThreadCreated")).threadId
}

describe("threads (docs/design/durable-harness.md)", () => {
  for (const command of ["CreateThread", "PromptThread"] as const) {
    for (const boundary of ["command", "event"] as const) {
      test(`${command} admission rolls back its row, events and command on ${boundary} failure`, async () => {
        const scene = await threadScene()
        const { hub, web, sessionId, mod } = scene
        const threadId = command === "PromptThread" ? await bobStartsThread(scene) : undefined
        if (threadId !== undefined) await mod.next("StartThread", 500)
        // Snapshot existing history and commands, including any earlier thread. Abort a real
        // SQLite write, not a mock: it must unwind every preceding write in this admission.
        const snapshot = () =>
          hub.run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return {
                threads: yield* sql`SELECT * FROM threads WHERE session_id = ${sessionId}`,
                events:
                  yield* sql`SELECT * FROM session_events WHERE session_id = ${sessionId} ORDER BY seq`,
                commands:
                  yield* sql`SELECT * FROM thread_commands WHERE session_id = ${sessionId} ORDER BY seq`,
              }
            }),
          )
        const before = await snapshot()
        await hub.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(
              boundary === "command"
                ? `CREATE TRIGGER fail_admission AFTER INSERT ON thread_commands
               BEGIN SELECT RAISE(ABORT, 'injected command admission failure'); END`
                : `CREATE TRIGGER fail_admission AFTER INSERT ON session_events
               WHEN json_extract(NEW.event, '$._tag') = 'ThreadPromptSent'
               BEGIN SELECT RAISE(ABORT, 'injected event admission failure'); END`,
            )
          }),
        )
        // Drain earlier broadcasts before checking that rollback publishes nothing new.
        for (const _ of await web.untaken("SessionEventLogged"))
          await web.take("SessionEventLogged")
        const message =
          command === "CreateThread"
            ? {
                _tag: command,
                requestId: request(),
                sessionId,
                anchorTurnId: "t-1",
                text: "atomic prompt",
              }
            : {
                _tag: command,
                requestId: request(),
                sessionId,
                threadId: defined(threadId),
                text: "atomic prompt",
              }
        web.send(message)
        expect((await web.take("CommandFailed")).command).toBe(command)
        expect(await snapshot()).toEqual(before)
        expect(await web.untaken("SessionEventLogged")).toEqual([])
        expect(await web.untaken("ThreadCreated")).toEqual([])
        expect(withoutPresence(await mod.poll())).toEqual([])

        await hub.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`DROP TRIGGER fail_admission`
          }),
        )
        web.send(message)
        const sent = (
          await web.take(
            "SessionEventLogged",
            (m) =>
              m.entry.event._tag === "ThreadPromptSent" && m.entry.event.text === "atomic prompt",
          )
        ).entry.event
        expect(sent._tag).toBe("ThreadPromptSent")
        const delivered = await mod.next(
          command === "CreateThread" ? "StartThread" : "DeliverThreadPrompt",
          500,
        )
        expect(delivered).toHaveLength(1)
        expect(delivered[0]).toMatchObject({
          text: "atomic prompt",
          promptId: (sent as { promptId: string }).promptId,
        })
        const after = await snapshot()
        expect(after.commands).toHaveLength(before.commands.length + 1)
        expect(after.events).toHaveLength(
          before.events.length + (command === "CreateThread" ? 2 : 1),
        )
        expect(after.threads).toHaveLength(
          before.threads.length + (command === "CreateThread" ? 1 : 0),
        )
      })
    }
  }

  test("committed thread prompts reopen with their commands and replay until a Turn or steer receipt", async () => {
    const dir = testDatabaseDir("kndl-thread-admission-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const scene = await threadScene([gpt], database)
      const { hub, web, mod, sessionId, runnerToken, start } = scene
      const threadId = await bobStartsThread(scene)
      const [first] = await mod.next("StartThread", 500)
      web.send({
        _tag: "PromptThread",
        requestId: request(),
        sessionId,
        threadId,
        text: "another saved prompt",
      })
      const [next] = await mod.next("DeliverThreadPrompt", 500)
      const admitted = [defined(first), defined(next)] satisfies [Command, Command]
      // Neither a poll nor loss of the in-memory outbox is an admission receipt for a prompt.
      await web.close()
      await scene.bobWeb.close()
      await scene.runner.close()
      await hub.stop()

      const { hub: reopened } = await piHub([gpt], database)
      const saved = await reopened.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const prompts = yield* sql<{ readonly promptId: string }>`
          SELECT json_extract(event, '$.promptId') AS promptId FROM session_events
          WHERE session_id = ${sessionId} AND json_extract(event, '$._tag') = 'ThreadPromptSent'
          ORDER BY seq
        `
          const commands = yield* sql<{ readonly command: string }>`
          SELECT command FROM thread_commands WHERE session_id = ${sessionId} ORDER BY seq
        `
          return { prompts, commands: commands.map((row) => JSON.parse(row.command)) }
        }),
      )
      expect(saved.prompts.map((p) => p.promptId)).toEqual(admitted.map((c) => c.promptId))
      expect(saved.commands).toEqual(admitted)
      const back = await openRunner(
        reopened,
        runnerToken,
        [sessionId],
        undefined,
        true,
        piRunner.runnerHello,
      )
      const resumed = new Mod(reopened, sessionId, start.modToken)
      expect((await resumed.hello({ durable: true })).status).toBe(200)
      expect(withoutPresence(await resumed.poll(500))).toEqual(admitted)
      await resumed.post(
        {
          _tag: "TurnStarted",
          threadId,
          turnId: "t-saved",
          promptId: admitted[0].promptId,
          text: admitted[0].text,
          sender: { _tag: "FromParticipant", participant: bob },
        },
        {
          _tag: "PromptSteered",
          threadId,
          turnId: "t-saved",
          promptId: admitted[1].promptId,
          text: admitted[1].text,
          sender: alice,
        },
      )
      expect(
        await reopened.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql`SELECT * FROM thread_commands WHERE session_id = ${sessionId}`
          }),
        ),
      ).toEqual([])
      await resumed.poll() // Acknowledge the previous HTTP poll's in-memory outbox entries.
      expect((await resumed.hello({ durable: true })).status).toBe(200)
      expect(withoutPresence(await resumed.poll(100))).toEqual([])
      await back.close()
      await reopened.stop()
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a duplicate thread prompt receipt leaves the main queue and its in-flight delivery alone", async () => {
    const scene = await threadScene()
    const { hub, web, mod, sessionId } = scene
    await bobStartsThread(scene)
    const [thread] = await mod.next("StartThread", 500)
    await web.take("PromptQueueChanged", queueIs())
    web.send({ _tag: "SendPrompt", sessionId, text: "main in flight" })
    await web.take("PromptQueueChanged", queueIs("main in flight"))
    const [main] = await mod.deliveries(500)
    await mod.post({ _tag: "PromptAlreadySubmitted", promptId: defined(thread).promptId })
    expect(await web.untaken("PromptQueueChanged")).toEqual([])
    web.send({ _tag: "SendPrompt", sessionId, text: "main waiting" })
    await web.take("PromptQueueChanged", queueIs("main in flight", "main waiting"))
    expect(await mod.deliveries(100)).toEqual([])
    expect(
      await hub.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT * FROM thread_commands WHERE session_id = ${sessionId}`
        }),
      ),
    ).toEqual([])
    await mod.post(turnStarted("t-main", defined(main).promptId))
    await web.take("PromptQueueChanged", queueIs("main waiting"))
  })

  test("anyone starts one off a main-loop Turn: logged, kept with the Session, and sent to the agent", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    expect(threadId).toStartWith("thr_")

    const started = (await web.take("SessionEventLogged", loggedTag("ThreadStarted"))).entry.event
    expect(started).toEqual({
      _tag: "ThreadStarted",
      threadId,
      anchorTurnId: "t-1",
      title: "what about Windows?",
      startedBy: bob,
      // Its own, the Session's when it was started: it doesn't follow the Session's.
      model: "anthropic/claude-opus-5-5",
    })
    const sent = (await web.take("SessionEventLogged", loggedTag("ThreadPromptSent"))).entry.event
    expect(sent).toEqual({
      _tag: "ThreadPromptSent",
      threadId,
      promptId: expect.any(String),
      requestId: expect.any(String),
      sender: bob,
      text: "what about Windows?\nAnd macOS.",
    })
    expect(await mod.next("StartThread", 500)).toEqual([
      {
        _tag: "StartThread",
        sessionId,
        threadId,
        anchorTurnId: "t-1",
        promptId: (sent as { readonly promptId: string }).promptId,
        text: "what about Windows?\nAnd macOS.",
        sender: bob,
        model: "anthropic/claude-opus-5-5",
      },
    ])
    const updated = await web.take("SessionUpdated", (m) => threadsOf(m).length > 0)
    expect(threadsOf(updated)).toEqual([
      {
        id: threadId,
        title: "what about Windows?",
        anchorTurnId: "t-1",
        startedBy: bob,
        running: false,
        model: "anthropic/claude-opus-5-5",
      },
    ])
    // Everyone who connects later sees it.
    expect((await openWeb(scene.hub, "carol")).sessions.sessions[0]?.threads).toEqual(
      threadsOf(updated),
    )
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
  })

  test("is refused off a Turn the main loop didn't have, or with a model its Creator hasn't", async () => {
    const scene = await threadScene([gpt, claudeOpus])
    const { bobWeb, sessionId, mod } = scene
    const create = async (more: Record<string, unknown>) => {
      bobWeb.send({
        _tag: "CreateThread",
        requestId: request(),
        sessionId,
        text: "hm",
        anchorTurnId: "t-1",
        ...more,
      })
      return (await bobWeb.take("CommandFailed")).message
    }
    expect(await create({ anchorTurnId: "t-nope" })).toBe(
      "There is no such Turn in the Session to start a thread off.",
    )
    // A thread's own Turn isn't the main loop's.
    const threadId = await bobStartsThread(scene)
    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-thread",
      threadId,
      text: "",
      sender: { _tag: "FromParticipant", participant: bob },
    })
    expect(await create({ anchorTurnId: "t-thread" })).toBe(
      "There is no such Turn in the Session to start a thread off.",
    )
    expect(await create({ model: "xai/grok-5" })).toBe("Model 'xai/grok-5' not found")
    expect(await create({ model: "sonnet" })).toContain("Claude Code's name for a model")

    // One of the Creator's, and a thinking level, start it on them.
    const other = await bobStartsThread(scene, {
      model: "openai/gpt-6-sol",
      thinkingLevel: "high",
    })
    const [start] = (await mod.next("StartThread", 500)).filter((c) => c.threadId === other)
    expect(start).toMatchObject({ model: "openai/gpt-6-sol", thinkingLevel: "high" })
  })

  test("is refused by an agent from before threads, which says so in its hello", async () => {
    const { hub } = await piHub([gpt])
    const scene = await sessionScene(hub, piSession)
    const { web, sessionId, mod } = scene
    await mod.post(...answered("t-1", "hi", "hello"))
    web.send({
      _tag: "CreateThread",
      requestId: request(),
      sessionId,
      anchorTurnId: "t-1",
      text: "more",
    })
    expect((await web.take("CommandFailed")).message).toBe(
      "This Session's agent doesn't take threads: restart it.",
    )
    web.send({ _tag: "CompactConversation", sessionId })
    expect((await web.take("CommandFailed")).message).toBe(
      "This Session's agent doesn't take threads: restart it.",
    )
    expect(await mod.next("StartThread", 100)).toEqual([])
  })

  test("its Turns run beside the main loop's: they set the thread running, never the Session's Turn", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    const [start] = await mod.next("StartThread", 500)
    const promptId = defined(start).promptId
    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-2",
      threadId,
      text: "[bob] what about Windows?",
      sender: { _tag: "FromParticipant", participant: bob },
      promptId,
    })
    const running = await web.take("SessionUpdated", (m) => threadsOf(m)[0]?.running === true)
    expect(running.session.currentTurn).toBeNull()

    // The main loop takes a prompt meanwhile, and its text streams apart from the thread's.
    bobWeb.send({ _tag: "SendPrompt", sessionId, text: "and on the main loop" })
    const [main] = await mod.deliveries(500)
    expect(main).toMatchObject({ text: "and on the main loop" })
    await mod.post(
      turnStarted("t-3", defined(main).promptId),
      { _tag: "TextDelta", turnId: "t-2", threadId, text: "Windows, too." },
      { _tag: "TextDelta", turnId: "t-3", text: "Main." },
    )
    expect((await web.take("SessionEventLogged", deltaOf("t-2"))).entry.event).toEqual({
      _tag: "TextDelta",
      turnId: "t-2",
      threadId,
      text: "Windows, too.",
    })
    expect((await web.take("SessionEventLogged", deltaOf("t-3"))).entry.event).toEqual({
      _tag: "TextDelta",
      turnId: "t-3",
      text: "Main.",
    })

    // The thread's end leaves the main loop's Turn running.
    await mod.post({ _tag: "TurnEnded", turnId: "t-2", threadId, reason: "stop", durationMs: 9 })
    await web.take(
      "SessionUpdated",
      (m) => threadsOf(m)[0]?.running === false && m.session.currentTurn === "t-3",
    )

    // And the main loop's ends its own.
    await mod.post(turnEnded("t-3"))
    await web.take("SessionUpdated", (m) => m.session.currentTurn === null)
  })

  test("anyone posts into it, and stops its Turn, which is logged", async () => {
    const scene = await threadScene()
    const { web, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    await mod.next("StartThread", 500)

    // Nothing runs in it yet.
    web.send({ _tag: "StopThread", sessionId, threadId })
    expect((await web.take("CommandFailed")).message).toBe("No Turn runs in the thread.")
    web.send({
      _tag: "PromptThread",
      requestId: request(),
      sessionId,
      threadId: "thr_nope",
      text: "?",
    })
    expect((await web.take("CommandFailed")).message).toBe("The Session has no such thread.")

    web.send({
      _tag: "PromptThread",
      requestId: request(),
      sessionId,
      threadId,
      text: "and Linux",
    })
    const sent = (
      await web.take(
        "SessionEventLogged",
        (m) => m.entry.event._tag === "ThreadPromptSent" && m.entry.event.sender.id === alice.id,
      )
    ).entry.event as { readonly promptId: string }
    expect(await mod.next("DeliverThreadPrompt", 500)).toEqual([
      {
        _tag: "DeliverThreadPrompt",
        sessionId,
        threadId,
        promptId: sent.promptId,
        text: "and Linux",
        sender: alice,
      },
    ])

    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-2",
      threadId,
      text: "",
      sender: { _tag: "FromParticipant", participant: bob },
    })
    await web.take("SessionUpdated", (m) => threadsOf(m)[0]?.running === true)
    web.send({ _tag: "StopThread", sessionId, threadId })
    expect(
      (await web.take("SessionEventLogged", loggedTag("TurnStopRequested"))).entry.event,
    ).toEqual({ _tag: "TurnStopRequested", by: alice, threadId })
    expect(await mod.next("StopThread", 500)).toEqual([{ _tag: "StopThread", sessionId, threadId }])
  })

  test("anyone switches its model, to one of the Creator's; a switch the agent can't make is undone", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    await mod.next("StartThread", 500)

    web.send({ _tag: "SetThreadModel", sessionId, threadId, model: "xai/grok-5" })
    expect((await web.take("CommandFailed")).message).toBe("Model 'xai/grok-5' not found")
    web.send({
      _tag: "SetThreadModel",
      sessionId,
      threadId,
      model: "openai/gpt-6-sol",
      thinkingLevel: "low",
    })
    expect(
      (await bobWeb.take("SessionEventLogged", loggedTag("ThreadModelChanged"))).entry.event,
    ).toEqual({
      _tag: "ThreadModelChanged",
      threadId,
      by: alice,
      model: "openai/gpt-6-sol",
      thinkingLevel: "low",
    })
    expect(
      threadsOf(
        await bobWeb.take("SessionUpdated", (m) => threadsOf(m)[0]?.model === "openai/gpt-6-sol"),
      ),
    ).toMatchObject([{ id: threadId, model: "openai/gpt-6-sol", thinkingLevel: "low" }])
    expect(await mod.next("SwitchThreadModel", 500)).toEqual([
      {
        _tag: "SwitchThreadModel",
        sessionId,
        threadId,
        model: "openai/gpt-6-sol",
        thinkingLevel: "low",
      },
    ])

    await mod.post({
      _tag: "ModelSwitchFailed",
      asked: "openai/gpt-6-sol",
      model: "anthropic/claude-opus-5-5",
      message: "no such model",
      threadId,
    })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "SetThreadModel",
      sessionId,
      message:
        "Couldn't switch the thread “what about Windows?” to openai/gpt-6-sol: no such model. It still runs on anthropic/claude-opus-5-5.",
    })
    expect(
      threadsOf(
        await bobWeb.take(
          "SessionUpdated",
          (m) =>
            threadsOf(m)[0]?.model === "anthropic/claude-opus-5-5" &&
            threadsOf(m)[0]?.thinkingLevel === "low",
        ),
      ),
    ).toHaveLength(1)
    // The Session's own model is as it was.
    expect(await bobWeb.untaken("CommandFailed")).toEqual([])
  })

  test("anyone compacts the main loop or a thread, with instructions", async () => {
    const scene = await threadScene()
    const { bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    await mod.next("StartThread", 500)
    bobWeb.send({ _tag: "CompactConversation", sessionId })
    bobWeb.send({ _tag: "CompactConversation", sessionId, threadId, instructions: "keep the plan" })
    const commands = await mod.next("Compact", 500)
    expect([...commands, ...(await mod.next("Compact", 200))]).toEqual([
      { _tag: "Compact", sessionId, sender: bob },
      { _tag: "Compact", sessionId, threadId, instructions: "keep the plan", sender: bob },
    ])
    // The agent says when it compacts, and what came of it: logged, redacted, for everyone.
    await mod.post(
      { _tag: "CompactionStarted", threadId, reason: "manual", by: bob },
      { _tag: "CompactionEnded", threadId, outcome: "compacted", summary: "We chose Windows." },
      { _tag: "PlanChanged", plan: { steps: [{ text: "Port it", status: "in_progress" }] } },
      {
        _tag: "UsageChanged",
        threadId,
        usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      },
    )
    for (const tag of [
      "CompactionStarted",
      "CompactionEnded",
      "PlanChanged",
      "UsageChanged",
    ] as const) {
      expect((await bobWeb.take("SessionEventLogged", loggedTag(tag))).entry.event._tag).toBe(tag)
    }
  })

  test("commands the agent hasn't taken are sent again after its next hello, until it has", async () => {
    const scene = await threadScene()
    const { hub, runner, web, bobWeb, sessionId } = scene
    const threadId = await bobStartsThread(scene)
    web.send({
      _tag: "SetThreadModel",
      sessionId,
      threadId,
      model: "openai/gpt-6-sol",
    })
    await web.take("SessionEventLogged", loggedTag("ThreadModelChanged"))

    // The agent exits before it takes them: its outbox goes with it.
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    // A prompt to the thread wakes it, as a prompt does.
    bobWeb.send({
      _tag: "PromptThread",
      requestId: request(),
      sessionId,
      threadId,
      text: "still there?",
    })
    const start = await runner.take("StartSession")
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const next = new Mod(hub, sessionId, start.modToken)
    expect((await next.hello({ durable: true })).status).toBe(200)
    const sent = withoutPresence(await next.poll(500))
    expect(sent.map((command) => command._tag)).toEqual([
      "StartThread",
      "SwitchThreadModel",
      "DeliverThreadPrompt",
    ])
    const [startThread, , prompt] = sent as [
      Extract<Command, { _tag: "StartThread" }>,
      Command,
      Extract<Command, { _tag: "DeliverThreadPrompt" }>,
    ]

    // The thread's first Turn took its prompt, and the second prompt steered it; the model switch
    // was polled past. A hello after that sends nothing again.
    await next.post(
      {
        _tag: "TurnStarted",
        turnId: "t-2",
        threadId,
        text: "",
        sender: { _tag: "FromParticipant", participant: bob },
        promptId: startThread.promptId,
      },
      {
        _tag: "PromptSteered",
        turnId: "t-2",
        threadId,
        promptId: prompt.promptId,
        text: "still there?",
        sender: bob,
      },
    )
    await web.take("SessionUpdated", (m) => threadsOf(m)[0]?.running === true)
    await next.poll()
    expect((await next.hello({ durable: true })).status).toBe(200)
    // Nor a prompt of the main loop's, whose queue none of them touched.
    expect(withoutPresence(await next.poll(200))).toEqual([])
  })

  test("a thread's prompt the agent fails is told to its sender, and not sent again", async () => {
    const scene = await threadScene()
    const { bobWeb, sessionId, mod } = scene
    await bobStartsThread(scene)
    const [start] = await mod.next("StartThread", 500)
    await mod.post({
      _tag: "PromptFailed",
      promptId: defined(start).promptId,
      message: "the fork failed",
    })
    expect(await bobWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "CreateThread",
      sessionId,
      message: "The thread could not be started: the fork failed",
    })
    await mod.poll()
    expect((await mod.hello({ durable: true })).status).toBe(200)
    expect(await mod.next("StartThread", 100)).toEqual([])
  })

  test("a thread started without a model gets the Session's as it is, and keeps it when the Session's changes", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    web.send({ _tag: "SetSessionModel", sessionId, thinkingLevel: "high" })
    await web.take("SessionUpdated", (m) => m.session.thinkingLevel === "high")
    const first = await bobStartsThread(scene)
    expect((await mod.next("StartThread", 500)).find((c) => c.threadId === first)).toMatchObject({
      model: "anthropic/claude-opus-5-5",
      thinkingLevel: "high",
    })
    expect(
      (await web.take("SessionEventLogged", loggedTag("ThreadStarted"))).entry.event,
    ).toMatchObject({ model: "anthropic/claude-opus-5-5", thinkingLevel: "high" })

    // The Session switches Model; the thread doesn't follow it.
    web.send({
      _tag: "SetSessionModel",
      sessionId,
      model: "openai/gpt-6-sol",
      thinkingLevel: "low",
    })
    await web.take("SessionUpdated", (m) => m.session.model === "openai/gpt-6-sol")
    const second = await bobStartsThread(scene)
    const updated = await bobWeb.take("SessionUpdated", (m) => threadsOf(m).length === 2)
    expect(
      threadsOf(updated).map((thread) => [thread.id, thread.model, thread.thinkingLevel]),
    ).toEqual([
      [first, "anthropic/claude-opus-5-5", "high"],
      [second, "openai/gpt-6-sol", "low"],
    ])
    // Another model of its own takes the thinking level asked for it, not the Session's.
    const third = await bobStartsThread(scene, { model: "anthropic/claude-opus-5-5" })
    const started = await mod.next("StartThread", 500)
    expect(started.find((c) => c.threadId === third)).toMatchObject({
      model: "anthropic/claude-opus-5-5",
    })
    expect(started.find((c) => c.threadId === third)).not.toHaveProperty("thinkingLevel")
  })

  test("a thread command's answers, refusals and echo carry its request id", async () => {
    const scene = await threadScene()
    const { bobWeb, web, sessionId } = scene
    bobWeb.send({
      _tag: "CreateThread",
      requestId: "req-create",
      sessionId,
      anchorTurnId: "t-nope",
      text: "hm",
    })
    expect(await bobWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "CreateThread",
      sessionId,
      requestId: "req-create",
      message: "There is no such Turn in the Session to start a thread off.",
    })
    bobWeb.send({
      _tag: "CreateThread",
      requestId: "req-ok",
      sessionId,
      anchorTurnId: "t-1",
      text: "hm",
    })
    const created = await bobWeb.take("ThreadCreated")
    expect(created).toMatchObject({ requestId: "req-ok", sessionId })

    // The token is masked in the echo, so the sender can only tell its reply by the request id.
    const token = setupTokenOf("alice")
    web.send({
      _tag: "PromptThread",
      requestId: "req-reply",
      sessionId,
      threadId: created.threadId,
      text: `use ${token}`,
    })
    const echoes = []
    for (let echo = 0; echo < 2; echo++) {
      echoes.push((await web.take("SessionEventLogged", loggedTag("ThreadPromptSent"))).entry.event)
    }
    expect(echoes).toMatchObject([
      { requestId: "req-ok", text: "hm" },
      { requestId: "req-reply", text: `use ${stars(token)}` },
    ])
    web.send({
      _tag: "PromptThread",
      requestId: "req-lost",
      sessionId,
      threadId: "thr_nope",
      text: "?",
    })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "PromptThread",
      sessionId,
      requestId: "req-lost",
      message: "The Session has no such thread.",
    })
  })

  test("a thread's title is redacted in the Session's summary, as in its log", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    const token = setupTokenOf("alice")
    const threadId = await bobStartsThread(scene, { text: `why does ${token} fail?` })
    await mod.next("StartThread", 500)
    const updated = await web.take("SessionUpdated", (m) => threadsOf(m).length > 0)
    expect(threadsOf(updated)[0]?.title).toBe(`why does ${stars(token)} fail?`)
    // Nor does a switch the agent can't make say it.
    bobWeb.send({ _tag: "SetThreadModel", sessionId, threadId, model: "openai/gpt-6-sol" })
    await mod.next("SwitchThreadModel", 500)
    await mod.post({
      _tag: "ModelSwitchFailed",
      asked: "openai/gpt-6-sol",
      model: "anthropic/claude-opus-5-5",
      message: "no such model",
      threadId,
    })
    expect((await bobWeb.take("CommandFailed")).message).toContain(`why does ${stars(token)} fail?`)
    // Everyone who connects later, too.
    const later = await openWeb(scene.hub, "carol")
    expect(later.sessions.sessions[0]?.threads?.[0]?.title).toBe(`why does ${stars(token)} fail?`)
    for (const peer of [web, bobWeb, later]) expect(peer.texts.join("\n")).not.toContain(token)
  })

  test("a reply the agent fails is logged as failed for everyone, and leaves the thread as it was", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    await mod.next("StartThread", 500)
    web.send({ _tag: "PromptThread", requestId: request(), sessionId, threadId, text: "and Linux" })
    const [reply] = await mod.next("DeliverThreadPrompt", 500)
    await mod.post({
      _tag: "PromptFailed",
      promptId: defined(reply).promptId,
      message: "storage is full",
    })
    for (const peer of [web, bobWeb]) {
      expect(
        (await peer.take("SessionEventLogged", loggedTag("ThreadPromptFailed"))).entry.event,
      ).toEqual({
        _tag: "ThreadPromptFailed",
        threadId,
        promptId: defined(reply).promptId,
        message: "storage is full",
      })
    }
    // Nothing is sent to its sender besides: the log says it, and the thread is still there.
    expect(await web.untaken("CommandFailed")).toEqual([])
    web.send({ _tag: "PromptThread", requestId: request(), sessionId, threadId, text: "again" })
    expect(await web.untaken("CommandFailed")).toEqual([])
    expect(await mod.next("DeliverThreadPrompt", 500)).toMatchObject([{ text: "again" }])
    // Sent again, the failed one isn't.
    await mod.poll()
    expect((await mod.hello({ durable: true })).status).toBe(200)
    expect(await mod.next("DeliverThreadPrompt", 100)).toMatchObject([{ text: "again" }])
  })

  test("a thread the agent could not start is dropped with its prompt: no later reply is taken", async () => {
    const scene = await threadScene()
    const { web, bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    const [start] = await mod.next("StartThread", 500)
    await web.take("SessionUpdated", (m) => threadsOf(m).length === 1)
    await mod.post({
      _tag: "PromptFailed",
      promptId: defined(start).promptId,
      message: "The main loop has nothing to fork a thread from yet.",
    })
    expect(
      (await web.take("SessionEventLogged", loggedTag("ThreadPromptFailed"))).entry.event,
    ).toEqual({
      _tag: "ThreadPromptFailed",
      threadId,
      promptId: defined(start).promptId,
      message: "The main loop has nothing to fork a thread from yet.",
      threadDropped: true,
    })
    expect(
      (await web.take("SessionUpdated", (m) => threadsOf(m).length === 0)).session.threads,
    ).toBe(undefined)
    expect((await openWeb(scene.hub, "carol")).sessions.sessions[0]?.threads).toBeUndefined()
    // Its sender is told, as the thread says nothing; the others aren't.
    expect(await bobWeb.take("CommandFailed")).toMatchObject({
      command: "CreateThread",
      message:
        "The thread could not be started: The main loop has nothing to fork a thread from yet.",
    })
    expect(await web.untaken("CommandFailed")).toEqual([])
    web.send({ _tag: "PromptThread", requestId: request(), sessionId, threadId, text: "hello?" })
    expect((await web.take("CommandFailed")).message).toBe("The Session has no such thread.")
  })

  test("a Session put to sleep isn't woken for a thread's model switch, which it takes as it wakes", async () => {
    const scene = await threadScene()
    const { runner, web, bobWeb, sessionId, mod } = scene
    const threadId = await bobStartsThread(scene)
    // Its first prompt is taken, so none waits for the agent.
    const [start] = await mod.next("StartThread", 500)
    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-2",
      threadId,
      text: "",
      sender: { _tag: "FromParticipant", participant: bob },
      promptId: defined(start).promptId,
    })
    await mod.post({ _tag: "TurnEnded", turnId: "t-2", threadId, reason: "stop", durationMs: 9 })
    await web.take("SessionUpdated", (m) => threadsOf(m)[0]?.running === false)
    web.send({ _tag: "SleepSession", sessionId })
    expect(await runner.take("StopSession")).toMatchObject({ reason: "Sleep" })
    // Queued while it goes to sleep: kept for the agent, and no prompt for it.
    bobWeb.send({ _tag: "SetThreadModel", sessionId, threadId, model: "openai/gpt-6-sol" })
    await bobWeb.take("SessionEventLogged", loggedTag("ThreadModelChanged"))
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(await runner.untaken("StartSession")).toEqual([])
  })

  test("a thread's late TurnEnded leaves a later Turn of it running", async () => {
    const scene = await threadScene()
    const { web, sessionId, mod, runner } = scene
    const threadId = await bobStartsThread(scene)
    const [start] = await mod.next("StartThread", 500)
    const started = (turnId: string) => ({
      _tag: "TurnStarted" as const,
      turnId,
      threadId,
      text: "",
      sender: { _tag: "FromParticipant" as const, participant: bob },
      ...(turnId === "t-2" && { promptId: defined(start).promptId }),
    })
    await mod.post(started("t-2"), started("t-3"))
    await web.take("SessionUpdated", (m) => threadsOf(m)[0]?.running === true)
    // The earlier Turn ends late: the later one runs on.
    await mod.post({ _tag: "TurnEnded", turnId: "t-2", threadId, reason: "stop", durationMs: 9 })
    await web.take("SessionEventLogged", turnEndedLogged("t-2"))
    const carol = await openWeb(scene.hub, "carol")
    expect(carol.sessions.sessions[0]?.threads?.[0]?.running).toBe(true)
    // The agent stopping ends it, aborted.
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })
    expect(
      (await web.take("SessionEventLogged", turnEndedLogged("t-3"))).entry.event,
    ).toMatchObject({ reason: "aborted", threadId })
  })

  test("a running thread keeps the Session from idling to sleep, and its Turn is aborted when the agent stops", async () => {
    const sleepy = await startHub({
      config: { devLogin: true, sleepAfterMs: 200 },
      modelCatalog: Layer.succeed(ModelCatalog, {
        modelsFor: () => Effect.succeed([gpt]),
        signedIn: () => Effect.succeed([]),
      }),
    })
    const { runner, web, sessionId, mod } = await sessionScene(sleepy, piSession)
    expect((await mod.hello({ durable: true })).status).toBe(200)
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post(...answered("t-1", "hi", "hello"))
    web.send({
      _tag: "CreateThread",
      requestId: request(),
      sessionId,
      anchorTurnId: "t-1",
      text: "more",
    })
    const threadId = (await web.take("ThreadCreated")).threadId
    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-2",
      threadId,
      text: "",
      sender: { _tag: "FromParticipant", participant: alice },
    })
    await web.take("SessionUpdated", (m) => threadsOf(m)[0]?.running === true)
    web.send({ _tag: "LeaveSession", sessionId })

    // Idle well past its wait but for the thread, it isn't put to sleep.
    await Bun.sleep(600)
    expect(await runner.untaken("StopSession")).toEqual([])

    // Its agent stops: the thread's Turn ends, aborted, and the Session sleeps.
    joinSession(web, sessionId)
    await web.take("SessionHistory", (m) => m.sessionId === sessionId)
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })
    const aborted = await web.take(
      "SessionEventLogged",
      (m) => m.entry.event._tag === "TurnEnded" && m.entry.event.turnId === "t-2",
    )
    expect(aborted.entry.event).toEqual({
      _tag: "TurnEnded",
      turnId: "t-2",
      threadId,
      reason: "aborted",
      durationMs: expect.any(Number),
      errorMessage: "The agent exited with code 1",
    })
    const asleepNow = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(threadsOf(asleepNow)).toMatchObject([{ id: threadId, running: false }])
  })

  test("an agent's resumed Turn runs as the main loop's, and takes no prompt from the queue", async () => {
    const scene = await threadScene()
    const { web, sessionId, mod } = scene
    await web.take("PromptQueueChanged", queueIs())
    web.send({ _tag: "SendPrompt", sessionId, text: "queued" })
    await web.take("PromptQueueChanged", queueIs("queued"))
    const [delivered] = await mod.deliveries(500)
    expect(delivered).toMatchObject({ text: "queued" })
    await mod.post(turnStarted("t-r", undefined, { _tag: "Resumed" }))
    const resumed = await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-r")
    expect(resumed.session.currentTurn).toBe("t-r")
    // The prompt it was sent waits on in the queue, for its own Turn.
    expect(await web.untaken("PromptQueueChanged")).toEqual([])
  })

  test("the agent's history and a handoff hold the main loop's Turns, not threads'", async () => {
    const scene = await threadScene()
    const { mod, web } = scene
    const threadId = await bobStartsThread(scene)
    await mod.post(
      {
        _tag: "TurnStarted",
        turnId: "t-2",
        threadId,
        text: "thread prompt",
        sender: { _tag: "FromParticipant", participant: bob },
      },
      { _tag: "TextDelta", turnId: "t-2", threadId, text: "thread answer" },
      { _tag: "TurnEnded", turnId: "t-2", threadId, reason: "stop", durationMs: 5 },
    )
    await web.take("SessionEventLogged", turnEndedLogged("t-2"))
    const { turns } = (await (await mod.history()).json()) as {
      turns: Array<{ prompt: string; answer: string }>
    }
    expect(turns.map((turn) => [turn.prompt, turn.answer])).toEqual([
      ["Add a health check", "Added /health."],
    ])
  })

  test("its Creator's Models are sent to everyone who joins, and again when they change", async () => {
    const scene = await threadScene([gpt])
    const { hub, web, sessionId } = scene
    const carol = await openWeb(hub, "carol")
    joinSession(carol, sessionId)
    expect(await carol.take("SessionModels")).toEqual({
      _tag: "SessionModels",
      sessionId,
      models: [gpt],
    })
    scene.catalogue.models = [gpt, grok]
    // As when alice's Claude credential changes, which Claude's Models come with.
    web.send({
      _tag: "SetClaudeCredential",
      requestId: "c",
      secret: "sk-ant-oat01-ANOTHER_FAKE_TOKEN_FOR_TESTS_0000",
    })
    expect(await carol.take("SessionModels", (m) => m.models.length === 2)).toEqual({
      _tag: "SessionModels",
      sessionId,
      models: [gpt, grok],
    })
  })
})

/** The events of the kinds a stop logs, as the client took them, in order. */
const stopEvents = async (web: Connection<Web>, count: number) => {
  const events = []
  for (let i = 0; i < count; i++) {
    events.push(
      (
        await web.take(
          "SessionEventLogged",
          (m) =>
            m.entry.event._tag === "TurnEnded" ||
            m.entry.event._tag === "QuestionClosed" ||
            (m.entry.event._tag === "SessionStateChanged" && m.entry.event.state !== "Active"),
        )
      ).entry.event,
    )
  }
  return events
}

describe("a main-loop Turn when the agent stops (docs/design/durable-harness.md)", () => {
  test("ends aborted, saying why, before its sync question is cancelled and the Session goes Asleep; its resumed run is a Turn of its own", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId, mod } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post(turnStarted("t-1"), {
      _tag: "QuestionAsked",
      turnId: "t-1",
      toolCallId: "toolu_ask",
      questions: [
        {
          question: "Which?",
          header: "Which",
          options: [{ label: "This" }, { label: "That" }],
          multiSelect: false,
        },
      ],
    })
    await web.take("SessionUpdated", (m) => m.session.openQuestion !== undefined)

    runner.send({ _tag: "SessionStopped", sessionId, reason: "Exited", exitCode: 1 })
    expect(await stopEvents(web, 3)).toEqual([
      {
        _tag: "TurnEnded",
        turnId: "t-1",
        reason: "aborted",
        durationMs: expect.any(Number),
        errorMessage: "The agent exited with code 1",
      },
      {
        _tag: "QuestionClosed",
        turnId: "t-1",
        toolCallId: "toolu_ask",
        outcome: { _tag: "Cancelled" },
      },
      { _tag: "SessionStateChanged", state: "Asleep", message: "The agent exited with code 1" },
    ])
    const sleeping = (await openWeb(hub, "carol")).sessions.sessions[0]
    expect(sleeping).toMatchObject({ currentTurn: null })
    expect(sleeping).not.toHaveProperty("openQuestion")

    // Woken, the agent goes on with the run: a Turn of its own, `Resumed`.
    web.send({ _tag: "WakeSession", sessionId })
    const start = await runner.take("StartSession")
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const woken = new Mod(hub, sessionId, start.modToken)
    expect((await woken.hello({ durable: true })).status).toBe(200)
    await woken.post(turnStarted("t-2", undefined, { _tag: "Resumed" }))
    await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-2")
  })

  test("ends aborted when the Session is archived, or its Runner is back without the agent", async () => {
    const scene = await sessionScene()
    const { web, sessionId, mod } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await mod.post(turnStarted("t-1"))
    await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")
    web.send({ _tag: "ArchiveSession", sessionId })
    expect((await stopEvents(web, 2))[0]).toEqual({
      _tag: "TurnEnded",
      turnId: "t-1",
      reason: "aborted",
      durationMs: expect.any(Number),
      errorMessage: "Archived by alice",
    })

    // A Runner that goes offline may come back with the agent still running: its Turn goes on.
    const other = await sessionScene()
    joinSession(other.web, other.sessionId)
    await other.web.take("SessionHistory")
    await other.mod.post(turnStarted("t-1"))
    await other.web.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")
    await other.runner.close()
    await other.web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    await other.web.take("SessionEventLogged", stateChanged("Frozen"))
    expect(
      (await other.web.untaken("SessionEventLogged")).filter(
        (m) => m.entry.event._tag === "TurnEnded",
      ),
    ).toEqual([])
    // Back without it, the Turn is over.
    await openRunner(other.hub, other.runnerToken)
    expect((await stopEvents(other.web, 2))[0]).toMatchObject({
      _tag: "TurnEnded",
      turnId: "t-1",
      reason: "aborted",
      errorMessage: "mac is back; the agent is not running there",
    })
  })

  test("logs no Turn's end for a Session with none running", async () => {
    const scene = await sessionScene()
    const { web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await asleep(scene)
    expect(
      (await web.untaken("SessionEventLogged")).filter((m) => m.entry.event._tag === "TurnEnded"),
    ).toEqual([])
  })
})
