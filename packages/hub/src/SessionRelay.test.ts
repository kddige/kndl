// The Session relay, end to end: a real Hub, a fake Runner and web clients over WebSockets, and
// a fake mod over HTTP, as the real ones will talk to it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DefaultEnvironmentDraft,
  EnvironmentVersion,
  type ModCommandsEncoded,
  type ModEventsEncoded,
  Participant,
  ParticipantId,
  ProtocolVersion,
} from "@claude-hub/protocol"
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

  async hello() {
    const response = await this.request("/mod/hello", {
      _tag: "ModHello",
      protocolVersion: ProtocolVersion,
      sessionId: this.sessionId,
      claudeSessionId: "claude-1",
      model: "claude-opus",
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
async function sessionScene(hub?: TestHub) {
  const theHub = hub ?? (await startHub({ config: { devLogin: true } }))
  const runnerToken = (await issueRunnerToken(theHub)).token
  const runner = await openRunner(theHub, runnerToken)
  const web = await openWeb(theHub, "alice")
  await seedEnvironment(theHub, "kddige/claude-hub", "dev:alice")
  web.send({
    _tag: "CreateSession",
    requestId: "req-1",
    repo: "kddige/claude-hub",
    baseBranch: "main",
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
      repo: "kddige/claude-hub",
      baseBranch: "main",
      workBranch: `claude/${sessionId}`,
      modToken: start.modToken,
      environment: expect.any(Object),
    })
    expect(start.environment?.version).toBe(1)
    expect(start.modToken).toStartWith("chm_")
    expect(created).toMatchObject({
      requestId: "req-1",
      session: {
        id: sessionId,
        repo: "kddige/claude-hub",
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
      repo: "kddige/claude-hub",
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
    await seedEnvironment(hub, "kddige/claude-hub", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/claude-hub",
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
      repo: "kddige/claude-hub",
      baseBranch: "main",
      workBranch: `claude/${sessionId}`,
      modToken: wake.modToken,
      resume: "claude-1",
      environment: expect.any(Object),
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
          "kddige/claude-hub",
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
    await seedEnvironment(hub, "kddige/claude-hub", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/claude-hub",
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
    await seedEnvironment(hub, "kddige/claude-hub", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/claude-hub",
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

    // The WIP push failed: the archive stands, with the failure in its history.
    runner.send({ _tag: "WipPushFailed", sessionId, message: "git push exited with 128" })
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "WipNotPushed")).entry
        .event,
    ).toEqual({ _tag: "WipNotPushed", message: "git push exited with 128" })
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
    await seedEnvironment(hub, "kddige/claude-hub", "dev:alice")
    web.send({
      _tag: "CreateSession",
      requestId: "r",
      repo: "kddige/claude-hub",
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
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-"))
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
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-"))
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
      repo: "kddige/claude-hub",
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

  test("the Runner hears when a Turn ends, but not when a subagent's does", async () => {
    const { runner, mod, sessionId } = await sessionScene()
    await mod.post(turnStarted("t-1"))
    await mod.post(turnEnded("t-1", "subagent-1"))
    expect(await runner.untaken("SessionTurnEnded")).toEqual([])
    await mod.post(turnEnded("t-1"))
    expect(await runner.take("SessionTurnEnded")).toEqual({ _tag: "SessionTurnEnded", sessionId })
  })

  test("a failed WIP push is in the Session's history", async () => {
    const { runner, web, sessionId } = await sessionScene()
    joinSession(web, sessionId)
    await web.take("SessionHistory")
    runner.send({ _tag: "WipPushFailed", sessionId, message: "remote rejected" })
    expect((await web.take("SessionEventLogged")).entry.event).toEqual({
      _tag: "WipNotPushed",
      message: "remote rejected",
    })
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
      github.installedOn.add("kddige/claude-hub")
      return startHub({
        config: {
          devLogin: true,
          githubAppId: Option.some(appId),
          githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
          githubApiUrl: github.url,
        },
      })
    }

    test("Repo access is an installation token, with the App's bot as author", async () => {
      const { runner, sessionId } = await sessionScene(await appHub())
      const access = await ask(runner, sessionId, { _tag: "GitAccess" })

      expect(access).toMatchObject({
        _tag: "GitAccess",
        repo: "kddige/claude-hub",
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

      expect(answer).toMatchObject({ _tag: "SandboxToken", token: github.mintedTokens[0] })
      const mint = github.requests.find((request) => request.path.endsWith("/access_tokens"))
      expect(mint?.body).toEqual({ repositories: ["claude-hub"] })
      // A refresh is a new token.
      const again = await ask(runner, sessionId, { _tag: "SandboxToken" })
      expect((again as { token: string }).token).toBe(github.mintedTokens[1] ?? "")
      expect(github.mintedTokens[1]).not.toBe(github.mintedTokens[0])
    })

    test("the Session's current and previous Sandbox tokens are redacted from all it prints", async () => {
      const { runner, web, sessionId, mod } = await sessionScene(await appHub())
      joinSession(web, sessionId)
      await web.take("SessionHistory")
      web.send({ _tag: "OpenTerminal", sessionId })
      await runner.take("RequestTerminalSnapshot")

      await ask(runner, sessionId, { _tag: "SandboxToken" })
      await ask(runner, sessionId, { _tag: "SandboxToken" })
      const [previous = "", current = ""] = github.mintedTokens

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
      runner.send({ _tag: "WipPushFailed", sessionId, message: `bad token ${current}` })
      runner.send({
        _tag: "TerminalFrame",
        sessionId,
        kind: "Snapshot",
        data: `$ cat /run/claude-hub/github-token\r\n${current}\r\n$ `,
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
        { _tag: "WipNotPushed", message: `bad token ${stars(current)}` },
      ])
      expect((await web.take("TerminalFrame")).data).toBe(
        `$ cat /run/claude-hub/github-token\r\n${stars(current)}\r\n$ `,
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
      const [oldest = "", previous = ""] = github.mintedTokens

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

  const repo = "kddige/claude-hub"
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
      { _tag: "StopTurn" },
      { _tag: "SleepSession" },
      { _tag: "WakeSession" },
      { _tag: "RestartSession" },
      { _tag: "ArchiveSession" },
      { _tag: "RestoreSession" },
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
    expect((await runner.untaken("StartSession")).map((start) => start.repo)).toEqual([repo])
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
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-"))
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
