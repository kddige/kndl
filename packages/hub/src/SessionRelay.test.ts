// The Session relay, end to end: a real Hub, a fake Runner and web clients over WebSockets, and
// a fake mod over HTTP, as the real ones will talk to it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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
import { Effect, Exit, Option, Redacted } from "effect"
import { signInCookie } from "./Auth.ts"
import { databaseAt } from "./Database.ts"
import { Environments } from "./Environments.ts"
import { HubConfig, type HubConfigInput } from "./HubConfig.ts"
import { SignIns } from "./SignIns.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  runnerLogin,
  stopAll,
  type Tagged,
  type ToRunner,
  type Web,
} from "./testChannels.ts"
import { appId, appKeyPair, appSlug, botUserId, StandInGitHub } from "./testGitHubApi.ts"
import { baseConfig, bearer, seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

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
      claudeSessionId: "claude-1",
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

  /** The prompts delivered since the last poll. */
  async deliveries(waitMs = 0) {
    return (await this.poll(waitMs)).filter((command) => command._tag === "DeliverPrompt")
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
    baseBranch: "main",
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
  reason: "Answered",
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
        runnerLogin,
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

  test("is refused when no Runner is online", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    web.send({
      _tag: "CreateSession",
      requestId: "req-1",
      repo: "kddige/kndl",
      baseBranch: "main",
    })

    expect(await web.take("CommandFailed")).toMatchObject({
      command: "CreateSession",
      requestId: "req-1",
      message: "No Runner is online.",
    })
  })

  test("lists the Runner and the Session to web clients that connect later", async () => {
    const { hub, session } = await sessionScene()
    const bobWeb = await openWeb(hub, "bob")

    expect(bobWeb.runners.runners).toMatchObject([
      { name: "mac", login: runnerLogin, isOnline: true },
    ])
    expect(bobWeb.sessions.sessions).toEqual([session])
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

  test("refuses to join a Session that doesn't exist", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    joinSession(web, "no-such-session")

    expect(await web.take("CommandFailed")).toMatchObject({
      command: "JoinSession",
      sessionId: "no-such-session",
    })
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
  test("keeps prompts in order with their senders, for every joined client, and cancels them", async () => {
    const { hub, web, sessionId, mod } = await sessionScene()
    // A Turn typed at the terminal is running, so the queue waits.
    await mod.post(turnStarted("t-0"))
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    joinSession(bobWeb, sessionId)

    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    await bobWeb.take("PromptQueueChanged", queueIs("one"))
    bobWeb.send({ _tag: "SendPrompt", sessionId, text: "two" })
    await web.take("PromptQueueChanged", queueIs("one", "two"))
    web.send({ _tag: "SendPrompt", sessionId, text: "three" })
    const queued = await bobWeb.take("PromptQueueChanged", queueIs("one", "two", "three"))

    expect(queued.queue.map((prompt) => [prompt.text, prompt.sender])).toEqual([
      ["one", alice],
      ["two", bob],
      ["three", alice],
    ])

    // Any Participant may cancel any prompt.
    bobWeb.send({ _tag: "CancelPrompt", sessionId, promptId: queued.queue[0]?.id ?? "" })
    await web.take("PromptQueueChanged", queueIs("two", "three"))
    await bobWeb.take("PromptQueueChanged", queueIs("two", "three"))

    web.send({ _tag: "CancelPrompt", sessionId, promptId: queued.queue[0]?.id ?? "" })
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
    expect(await mod.deliveries(200)).toEqual([])

    await mod.post(turnEnded("t-1"))
    expect(await mod.deliveries(500)).toEqual([
      { _tag: "DeliverPrompt", sessionId, promptId: defined(two).id, text: "two", sender: alice },
    ])
    expect(await mod.deliveries(200)).toEqual([])
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
})

/** The prompts sent to join the running Turn since the last poll. */
const steers = async (mod: Mod, waitMs = 0) =>
  (await mod.poll(waitMs)).filter((command) => command._tag === "DeliverIntoTurn")

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

    // Any Participant may steer anyone's prompt.
    bobWeb.send({ _tag: "SteerPrompt", sessionId, promptId: defined(two).id })
    expect(await steers(mod, 500)).toEqual([
      { _tag: "DeliverIntoTurn", sessionId, promptId: defined(two).id, text: "two", sender: alice },
    ])
    // On its way into the Turn, it can't be cancelled, and is steered once.
    web.send({ _tag: "CancelPrompt", sessionId, promptId: defined(two).id })
    expect(await web.take("CommandFailed")).toMatchObject({ command: "CancelPrompt", sessionId })
    bobWeb.send({ _tag: "SteerPrompt", sessionId, promptId: defined(two).id })
    expect(await steers(mod, 200)).toEqual([])

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
    expect(await mod.deliveries(200)).toEqual([])
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
    expect(await steers(mod, 200)).toEqual([])
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

    bobWeb.send({ _tag: "SteerPrompt", sessionId, promptId: defined(one).id })
    expect(await steers(mod, 500)).toHaveLength(1)
    // The Turn ends before the mod answers: nothing is delivered until it does.
    await mod.post(turnEnded("t-0"))
    expect(await mod.deliveries(200)).toEqual([])

    await mod.post({
      _tag: "PromptFailed",
      promptId: defined(one).id,
      message: "the Turn ended before it could join",
    })
    expect(await bobWeb.take("CommandFailed")).toMatchObject({
      command: "SteerPrompt",
      sessionId,
      message: expect.stringContaining("the Turn ended before it could join"),
    })
    expect(await web.untaken("CommandFailed")).toEqual([])
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
    expect(await mod.poll(500)).toContainEqual({ _tag: "StopTurn", sessionId })
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
    expect(await mod.deliveries(200)).toEqual([])

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

  test("wakes a Session whose Claude Code stopped while it was away, if prompts wait", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    web.send({ _tag: "SendPrompt", sessionId, text: "still there?" })
    await web.take("PromptQueueChanged", queueIs("still there?"))

    const back = await openRunner(hub, runnerToken, [])
    expect(await back.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
  })

  test("leaves Sessions it no longer runs Asleep when it comes back", async () => {
    const { hub, runner, runnerToken, web, sessionId } = await sessionScene()
    await runner.close()
    await web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    await openRunner(hub, runnerToken, [])

    expect((await web.take("SessionUpdated", (m) => m.session.state === "Asleep")).session.id).toBe(
      sessionId,
    )
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
      baseBranch: "main",
    })
    const start = await runner.take("StartSession")
    const sessionId = start.sessionId
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    // The mod hasn't said hello, so the prompt waits in the queue.
    web.send({ _tag: "SendPrompt", sessionId, text: "hold on" })
    await web.take("PromptQueueChanged", queueIs("hold on"))
    web.send({ _tag: "LeaveSession", sessionId })
    await Bun.sleep(400)
    expect(await runner.untaken("StopSession")).toEqual([])

    const mod = new Mod(hub, sessionId, start.modToken)
    await mod.hello()
    runner.send({ _tag: "SessionStarted", sessionId })
    const [delivered] = await mod.deliveries(500)
    await mod.post(turnStarted("t-1", delivered?.promptId))
    await Bun.sleep(400)
    expect(await runner.untaken("StopSession")).toEqual([])

    joinSession(web, sessionId)
    await mod.post(turnEnded("t-1"))
    await Bun.sleep(400)
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
      resume: "claude-1",
      environment: expect.any(Object),
      gitIdentity: { name: "alice", email: "alice@dev-login.invalid" },
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
    expect(await woken.deliveries(200)).toEqual([])
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
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "the Sandbox did not start" })

    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
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
      message: "Claude Code could not start on mac: the Sandbox did not start",
    })
    // Not retried on its own, but the prompt stays queued for the next wake.
    expect(await runner.untaken("StartSession")).toEqual([])
    web.send({ _tag: "WakeSession", sessionId })
    expect(await runner.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
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
    expect(await mod.deliveries(200)).toEqual([])

    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested" })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(await runner.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
    await web.take("SessionUpdated", (m) => m.session.state === "Active")
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
    expect(woken).toMatchObject({ sessionId, resume: "claude-1" })
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
      baseBranch: "main",
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

  test("a start that fails is over too", async () => {
    const scene = await sessionScene()
    const { runner, web, sessionId } = scene
    await asleep(scene)
    web.send({ _tag: "WakeSession", sessionId })
    await runner.take("StartSession")
    await web.take("SessionUpdated", (m) => m.session.state === "Active" && !!m.session.starting)
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "no Docker" })
    const asleepAgain = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(asleepAgain.session.starting).toBeUndefined()
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
      baseBranch: "main",
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
      message: "Claude Code exited with code 1",
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
  test("any Participant can delete a Session: it is archived at once, and its Runner stops it for good", async () => {
    const scene = await sessionScene()
    const { hub, runner, web, sessionId, mod } = scene
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "OpenTerminal", sessionId })
    await runner.take("RequestTerminalSnapshot")

    // Bob didn't create it, and may delete it all the same.
    bobWeb.send({ _tag: "ArchiveSession", sessionId })
    expect(await runner.take("StopSession")).toEqual({
      _tag: "StopSession",
      sessionId,
      reason: "Archive",
    })
    const session = (await web.take("SessionUpdated", (m) => m.session.state === "Archived"))
      .session
    const at = defined(session.archived).at
    expect(session.archived).toEqual({ by: bob, at, purgeAt: at + thirtyDays })
    expect((await web.take("SessionEventLogged", stateChanged("Archived"))).entry.event).toEqual({
      _tag: "SessionStateChanged",
      state: "Archived",
      by: bob,
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
    bobWeb.send({ _tag: "ArchiveSession", sessionId })
    expect(await bobWeb.take("CommandFailed")).toMatchObject({
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
    expect(await runner.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
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
    expect(await runner.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
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
      baseBranch: "main",
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
    const scene = await sessionScene(await hubRetainingFor(400))
    const { runner, web, sessionId } = scene
    await archived(scene)
    web.send({ _tag: "RestoreSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    await Bun.sleep(600)
    expect(await web.untaken("SessionRemoved")).toEqual([])
    expect(await runner.untaken("PurgeSession")).toEqual([])

    await archived(scene)
    await web.take("SessionRemoved")
  })

  test("refuses unknown Sessions", async () => {
    const { web } = await sessionScene()
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
  test("anyone with access can rename a Session, and every client sees it live", async () => {
    const { hub, web, sessionId, session } = await sessionScene()
    expect(session.name).toBeUndefined()
    const bobWeb = await openWeb(hub, "bob")

    // Bob didn't create it, and may rename it all the same; the name is trimmed.
    bobWeb.send({ _tag: "RenameSession", sessionId, name: "  Health check " })
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-"))
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
  test("anyone with access can turn it on, every client sees who, and an idle Session stays up", async () => {
    const hub = await hubSleepingAfter(400)
    const bobWeb = await openWeb(hub, "bob")
    const { runner, web, sessionId } = await sessionScene(hub)
    bobWeb.send({ _tag: "SetKeepAwake", sessionId, on: true })
    for (const client of [web, bobWeb]) {
      const on = await client.take("SessionUpdated", keptAwake)
      expect(on.session.keepAwake?.by).toEqual(bob)
      expect(on.session.keepAwake?.at).toBeGreaterThan(0)
    }
    expect((await openWeb(hub, "carol")).sessions.sessions[0]?.keepAwake?.by).toEqual(bob)

    // Idle well past its wait, it isn't put to sleep.
    await Bun.sleep(1_000)
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
    expect(await runner.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
    const active = await web.take(
      "SessionUpdated",
      (m) => m.session.state === "Active" && m.session.keepAwake !== undefined,
    )
    expect(active.session.keepAwake?.by).toEqual(alice)
    expect(active.session.starting).toBeDefined()
  })

  test("its Runner back from a restart wakes it, and it outlives a Hub restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-"))
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
      expect(await back.take("StartSession")).toMatchObject({ sessionId, resume: "claude-1" })
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
  effort: true,
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
      effort: true,
    },
    {
      alias: "haiku",
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      description: "Fastest for quick answers",
      effort: false,
    },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
}
/** A Runner as it says hello since #128: with its models, and taking RelaunchSession. */
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

describe("model and effort (#128)", () => {
  test("a Runner's models reach the web in the Runners list", async () => {
    const { hub } = await sessionScene(undefined, modelRunner)
    expect((await openWeb(hub, "bob")).runners.runners).toMatchObject([
      { name: "mac", models: runnerModels },
    ])
  })

  test("a new Session starts on Claude Code's default, with no flags", async () => {
    const { start, session } = await sessionScene(undefined, modelRunner)
    expect(start).not.toHaveProperty("model")
    expect(start).not.toHaveProperty("effort")
    expect(session).not.toHaveProperty("model")
    expect(session).not.toHaveProperty("effort")
  })

  test("a new Session can start on a model and effort its Runner's Claude Code has", async () => {
    const { start, session } = await sessionScene(undefined, {
      ...modelRunner,
      create: { model: "sonnet", effort: "high" },
    })
    expect(start).toMatchObject({ model: "sonnet", effort: "high" })
    expect(session).toMatchObject({ model: "sonnet", effort: "high" })
    expect(session).not.toHaveProperty("modelPending")
  })

  test("a model or effort the Runner's Claude Code doesn't have is refused, in its words", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
      models: { ...runnerModels, efforts: ["low", "medium", "high"] },
      relaunches: true,
    })
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, "kddige/kndl", "dev:alice")
    const create = (more: Record<string, unknown>) =>
      web.send({
        _tag: "CreateSession",
        requestId: "r",
        repo: "kddige/kndl",
        baseBranch: "main",
        ...more,
      })

    create({ model: "gpt-5" })
    expect((await web.take("CommandFailed")).message).toBe("Model 'gpt-5' not found")
    create({ model: "haiku", effort: "low" })
    expect((await web.take("CommandFailed")).message).toBe("Haiku 4.5 takes no effort level.")
    create({ effort: "max" })
    expect((await web.take("CommandFailed")).message).toBe(
      "Claude Code on mac has no effort level 'max'.",
    )
    expect(await web.untaken("SessionCreated")).toEqual([])
  })

  test("a Runner that hasn't said its models takes only Claude Code's default", async () => {
    const { web, sessionId } = await sessionScene()
    web.send({ _tag: "SetSessionModel", sessionId, model: "sonnet" })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "SetSessionModel",
      sessionId,
      message:
        "mac hasn't said which models its Claude Code has: only Claude Code's default model can be used there.",
    })
  })

  test("anyone with access can change it: everyone sees it, and the history says who", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { hub, web, sessionId, session } = scene
    const bobWeb = await openWeb(hub, "bob")
    joinSession(web, sessionId)
    await web.take("SessionHistory")

    // Bob didn't create it, and may change it all the same.
    bobWeb.send({ _tag: "SetSessionModel", sessionId, model: "sonnet", effort: "high" })
    for (const client of [web, bobWeb]) {
      const changed = await client.take("SessionUpdated", (m) => m.session.model === "sonnet")
      expect(changed.session).toEqual({
        ...session,
        model: "sonnet",
        effort: "high",
        modelPending: true,
      })
    }
    expect((await web.take("SessionEventLogged", modelSwitched)).entry.event).toEqual({
      _tag: "ModelSwitched",
      by: bob,
      model: "sonnet",
      modelLabel: "Sonnet 5.5",
      effort: "high",
    })
    const later = await openWeb(hub, "carol")
    expect(later.sessions.sessions[0]).toMatchObject({ model: "sonnet", effort: "high" })

    // The same setting again changes nothing.
    await relaunched(scene)
    web.send({ _tag: "SetSessionModel", sessionId, model: "sonnet", effort: "high" })
    expect(await web.untaken("CommandFailed")).toEqual([])
    expect((await web.untaken("SessionEventLogged")).filter(modelSwitched)).toEqual([])

    // Back to the default: no model, named by the model Claude Code runs for it.
    web.send({ _tag: "SetSessionModel", sessionId, model: "default" })
    expect((await web.take("SessionEventLogged", modelSwitched)).entry.event).toEqual({
      _tag: "ModelSwitched",
      by: alice,
      modelLabel: "Opus 5.5",
    })
    const reset = await web.take("SessionUpdated", (m) => m.session.model === undefined)
    expect(reset.session).not.toHaveProperty("effort")
  })

  test("an idle Session's Claude Code is started again with it, resuming its conversation", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { web, sessionId, mod, start } = scene
    web.send({ _tag: "SetSessionModel", sessionId, model: "opus", effort: "xhigh" })
    const { relaunch, mod: newMod } = await relaunched(scene)
    expect(relaunch).toEqual({
      _tag: "RelaunchSession",
      sessionId,
      repo: "kddige/kndl",
      workBranch: `claude/${sessionId}`,
      resume: "claude-1",
      modToken: relaunch.modToken,
      model: "opus",
      effort: "xhigh",
    })
    // The old mod's token is gone with it.
    expect(relaunch.modToken).not.toBe(start.modToken)
    expect((await mod.hello()).status).toBe(401)
    const settled = await web.take(
      "SessionUpdated",
      (m) => m.session.model === "opus" && m.session.modelPending === undefined,
    )
    expect(settled.session.state).toBe("Active")

    web.send({ _tag: "SendPrompt", sessionId, text: "on Opus now" })
    expect((await newMod.deliveries(500)).map((command) => command.text)).toEqual(["on Opus now"])
  })

  test("never mid-Turn: it applies from the next Turn, which waits for the new Claude Code", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { runner, web, sessionId, mod } = scene
    await mod.post(turnStarted("t-1"))
    await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")

    web.send({ _tag: "SetSessionModel", sessionId, model: "sonnet" })
    await web.take("SessionUpdated", (m) => m.session.modelPending === true)
    web.send({ _tag: "SendPrompt", sessionId, text: "next" })
    expect(await runner.untaken("RelaunchSession")).toEqual([])
    expect(await mod.deliveries()).toEqual([])

    // The Turn ends: Claude Code is started again before the prompt goes, to the new mod.
    await mod.post(turnEnded("t-1"))
    const { relaunch, mod: newMod } = await relaunched(scene)
    expect(relaunch.model).toBe("sonnet")
    expect((await mod.hello()).status).toBe(401)
    expect((await newMod.deliveries(500)).map((command) => command.text)).toEqual(["next"])
  })

  test("an Asleep Session starts with it when it wakes", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { runner, web, sessionId } = scene
    await asleep(scene)
    web.send({ _tag: "SetSessionModel", sessionId, model: "haiku" })
    const changed = await web.take("SessionUpdated", (m) => m.session.model === "haiku")
    expect(changed.session).not.toHaveProperty("modelPending")

    web.send({ _tag: "WakeSession", sessionId })
    expect(await runner.take("StartSession")).toMatchObject({ resume: "claude-1", model: "haiku" })
    expect(await runner.untaken("RelaunchSession")).toEqual([])
  })

  test("a Runner from before RelaunchSession gets it when the Session next wakes", async () => {
    const scene = await sessionScene(undefined, { runnerHello: { models: runnerModels } })
    const { runner, web, sessionId } = scene
    web.send({ _tag: "SetSessionModel", sessionId, effort: "low" })
    await web.take("SessionUpdated", (m) => m.session.modelPending === true)
    expect(await runner.untaken("RelaunchSession")).toEqual([])

    await asleep(scene)
    web.send({ _tag: "WakeSession", sessionId })
    const wake = await runner.take("StartSession")
    expect(wake).toMatchObject({ effort: "low" })
    expect(wake).not.toHaveProperty("model")
  })

  test("Claude Code that doesn't start again leaves the Session Asleep, saying why", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    const { runner, web, sessionId } = scene
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    web.send({ _tag: "SetSessionModel", sessionId, model: "sonnet" })
    await runner.take("RelaunchSession")
    runner.send({ _tag: "SessionStartFailed", sessionId, message: "tmux is gone" })
    const asleepNow = await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect(asleepNow.session).toMatchObject({ model: "sonnet" })
    expect(asleepNow.session).not.toHaveProperty("modelPending")
    expect(
      (await web.take("SessionEventLogged", stateChanged("Asleep"))).entry.event,
    ).toMatchObject({ message: "Claude Code could not start on mac: tmux is gone" })
  })

  test("an Archived Session's model can't be changed", async () => {
    const scene = await sessionScene(undefined, modelRunner)
    await archived(scene)
    scene.web.send({ _tag: "SetSessionModel", sessionId: scene.sessionId, model: "sonnet" })
    expect((await scene.web.take("CommandFailed")).message).toBe(
      "The Session is archived: restore it to change its model.",
    )
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
      baseBranch: "main",
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
    const bobWeb = await openWeb(hub, "bob")
    bobWeb.send({ _tag: "TerminalInput", sessionId, data: "rm -rf /\r" })
    bobWeb.send({ _tag: "TerminalResize", sessionId, size: { cols: 10, rows: 5 } })
    expect((await bobWeb.take("CommandFailed")).command).toBe("TerminalInput")
    expect((await bobWeb.take("CommandFailed")).command).toBe("TerminalResize")
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-"))
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-"))
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

  test("a Runner's note about the Sandbox is in the Session's history", async () => {
    const { runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    runner.send({ _tag: "SandboxNote", sessionId, message: "Capped at 4 CPUs" })
    expect((await web.take("SessionEventLogged")).entry.event).toEqual({
      _tag: "SandboxNoted",
      message: "Capped at 4 CPUs",
    })
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
  web.send({ _tag: "CreateSession", requestId, repo: inRepo, baseBranch: "main" })
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

  /** A web client signed in with GitHub as `who`. */
  async function openGitHubWeb(hub: TestHub, who: typeof octocat) {
    const { token } = await hub.run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        return yield* signIns.signIn(Participant.make({ ...who, id: ParticipantId.make(who.id) }))
      }),
    )
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

  test("creating a Session needs access to its Repo", async () => {
    const { hub, runner } = await sessionScene(await accessHub())
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)

    for (const elsewhere of [secret, "kddige/not-installed"]) {
      octocatWeb.send({
        _tag: "CreateSession",
        requestId: "r",
        repo: elsewhere,
        baseBranch: "main",
      })
      expect(await octocatWeb.take("CommandFailed")).toEqual({
        _tag: "CommandFailed",
        command: "CreateSession",
        requestId: "r",
        message: `You have no access to ${elsewhere} on GitHub, or the GitHub App isn't installed on it.`,
      })
    }
    octocatWeb.send({ _tag: "CreateSession", requestId: "ok", repo, baseBranch: "main" })
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

  test("a collaborator can join, prompt and type, and GitHub is asked once", async () => {
    const { hub, runner, mod, sessionId } = await sessionScene(await accessHub())
    github.grant(repo, "octocat")
    const octocatWeb = await openGitHubWeb(hub, octocat)

    joinSession(octocatWeb, sessionId)
    expect(await octocatWeb.take("SessionHistory")).toMatchObject({ sessionId })
    await octocatWeb.take("PresenceChanged")
    await mod.poll()
    octocatWeb.send({ _tag: "SendPrompt", sessionId, text: "hi" })
    expect((await mod.deliveries(500)).map((delivery) => delivery.text)).toEqual(["hi"])
    octocatWeb.send({ _tag: "OpenTerminal", sessionId })
    await runner.take("RequestTerminalSnapshot")
    octocatWeb.send({ _tag: "TerminalInput", sessionId, data: "ls\r" })
    await runner.take("TerminalInput")
    octocatWeb.send({ _tag: "SetKeepAwake", sessionId, on: true })
    const kept = await octocatWeb.take("SessionUpdated", (m) => m.session.keepAwake !== undefined)
    expect(kept.session.keepAwake?.by).toMatchObject(octocat)

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
    for (const client of [web, octocatWeb]) {
      client.send({ _tag: "OpenTerminal", sessionId })
      await runner.take("RequestTerminalSnapshot")
    }

    github.revoke(repo, "octocat")
    expect(await octocatWeb.take("SessionRemoved")).toEqual({ _tag: "SessionRemoved", sessionId })
    expect((await web.take("PresenceChanged")).participants).toEqual([alice])
    const presence = (await mod.poll()).filter((command) => command._tag === "PresenceChanged")
    expect(presence.at(-1)).toMatchObject({ participants: [alice] })

    // Out of its terminal, and refused.
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
    const { hub, mod, sessionId } = await sessionScene(await accessHub({ repoAccessTtlMs: 100 }))
    github.grant(repo, "octocat")
    github.grant(repo, "hubot")
    const octocatWeb = await openGitHubWeb(hub, octocat)
    joinSession(octocatWeb, sessionId)
    await octocatWeb.take("PresenceChanged")

    github.collaboratorsDown = true
    await Bun.sleep(300)
    await mod.poll()
    octocatWeb.send({ _tag: "SendPrompt", sessionId, text: "hi" })
    expect((await mod.deliveries(500)).map((delivery) => delivery.text)).toEqual(["hi"])
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-"))
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
    await Bun.sleep(400)
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

  test("any Participant can message an agent: logged, sent to the mod, waking an Asleep Session", async () => {
    const scene = await agentScene()
    const { hub, runner, web, sessionId, mod } = scene
    const bobWeb = await openWeb(hub, "bob")
    await mod.poll()
    bobWeb.send({ _tag: "MessageAgent", sessionId, agentId: "a-1", text: "Check the docs too" })
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "AgentMessaged")).entry
        .event,
    ).toEqual({ _tag: "AgentMessaged", agentId: "a-1", sender: bob, text: "Check the docs too" })
    expect(await mod.poll(500)).toEqual([
      {
        _tag: "DeliverAgentMessage",
        sessionId,
        agentId: "a-1",
        text: "Check the docs too",
        sender: bob,
      },
    ])

    // Asleep, its agent Interrupted: a message wakes the Session, and its new mod resumes it.
    await asleep(scene)
    web.send({ _tag: "MessageAgent", sessionId, agentId: "a-1", text: "Carry on" })
    const wake = await runner.take("StartSession")
    expect(wake).toMatchObject({ sessionId, resume: "claude-1" })
    runner.send({ _tag: "SessionStarted", sessionId })
    const woken = new Mod(hub, sessionId, wake.modToken)
    expect((await woken.hello()).status).toBe(200)
    expect(await woken.poll(500)).toContainEqual({
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
    bobWeb.send({ _tag: "AnswerQuestion", sessionId, toolCallId: "toolu_ask", answer })
    expect(await mod.poll(500)).toEqual([
      { _tag: "DeliverAnswer", sessionId, toolCallId: "toolu_ask", answer, sender: bob },
    ])
    const outcome: ModEvent = {
      _tag: "QuestionClosed",
      turnId: "t-1",
      toolCallId: "toolu_ask",
      outcome: answer,
      by: bob,
    }
    await mod.post(outcome)
    await web.take("SessionUpdated", noQuestion)
    expect((await web.take("SessionEventLogged", closed)).entry.event).toEqual(outcome)

    // Too late: alice is told who answered first, and what, and the mod is sent nothing.
    web.send({ _tag: "AnswerQuestion", sessionId, toolCallId: "toolu_ask", answer })
    expect(await web.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "AnswerQuestion",
      sessionId,
      message: "bob answered first: Temporal.",
    })
    expect(await mod.poll()).toEqual([])
  })

  test("an answer the mod got after another is refused, saying who answered first", async () => {
    const { web, bobWeb, sessionId, mod } = await questionScene()
    web.send({
      _tag: "AnswerQuestion",
      sessionId,
      toolCallId: "toolu_ask",
      answer: { _tag: "Dismissed" },
    })
    bobWeb.send({
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
      { _tag: "AnswerFailed", toolCallId: "toolu_ask", senderId: bob.id, message: "closed" },
    )
    expect(await bobWeb.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "AnswerQuestion",
      sessionId,
      message: "alice dismissed the question first.",
    })
    expect(await web.untaken("CommandFailed")).toEqual([])

    // One the Hub knows nothing of says only that it came too late.
    await mod.post({
      _tag: "AnswerFailed",
      toolCallId: "toolu_other",
      senderId: bob.id,
      message: "No question is waiting on this answer.",
    })
    expect((await bobWeb.take("CommandFailed")).message).toBe(
      "Your answer came too late: No question is waiting on this answer.",
    )
  })

  test("picks are shown to everyone in the Session, and to those who join, until it closes", async () => {
    const { hub, web, bobWeb, sessionId, mod } = await questionScene()
    const pick = (answer: string, toolCallId = "toolu_ask") =>
      bobWeb.send({ _tag: "PickAnswer", sessionId, toolCallId, question: library, answer })
    pick("date-fns")
    expect(await web.take("QuestionPicks")).toEqual({
      _tag: "QuestionPicks",
      sessionId,
      toolCallId: "toolu_ask",
      picks: [{ participant: bob, question: library, answer: "date-fns" }],
    })
    pick("Temporal")
    await web.take("QuestionPicks", (m) => m.picks[0]?.answer === "Temporal")
    const another = await openWeb(hub, "alice", web.cookie)
    joinSession(another, sessionId)
    expect((await another.take("QuestionPicks")).picks).toEqual([
      { participant: bob, question: library, answer: "Temporal" },
    ])
    pick("")
    await web.take("QuestionPicks", (m) => m.picks.length === 0)

    // A pick for another question, or once it has closed, is moot.
    pick("date-fns", "toolu_other")
    await mod.post(turnEnded("t-1"))
    await web.take("SessionUpdated", noQuestion)
    pick("date-fns")
    await Bun.sleep(100)
    expect(await web.untaken("QuestionPicks")).toEqual([])
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
    await Bun.sleep(400)
    expect(await runner.untaken("StopSession")).toEqual([])
  })

  test("outlives a Hub restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-"))
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
