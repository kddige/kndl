// Runners follow the Hub's commit (issue #87, ADR 0011), end to end: a real Hub, web clients and
// fake Runners over WebSockets, and a fake mod over HTTP.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ModCommandsEncoded,
  type ModEventsEncoded,
  ProtocolVersion,
} from "@claude-hub/protocol"
import { Effect } from "effect"
import { databaseAt } from "./Database.ts"
import { HubVersion } from "./HubVersion.ts"
import { RunnerUpdatePush } from "./RunnerUpdatePush.ts"
import {
  Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type ToRunner,
} from "./testChannels.ts"
import { bearer, seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

type Command = ModCommandsEncoded["messages"][number]["message"]
type ModEvent = ModEventsEncoded["messages"][number]

const hubCommit = { commit: "a".repeat(40), branch: "main" }
const olderCommit = { commit: "b".repeat(40), branch: "main" }
const selfUpdating = { updater: { self: true } }
const alice = { id: "dev:alice", login: "alice", name: "alice" }
const repo = "kddige/claude-hub"

/** A Hub at hubCommit, whose history holds olderCommit, with dev login. */
const updatesHub = (database?: ReturnType<typeof databaseAt>) =>
  startHub({
    config: { devLogin: true },
    hubVersion: HubVersion.fixed(hubCommit, (commit) => commit === olderCommit.commit),
    ...(database !== undefined && { database }),
  })

/** A Session's fake mod, speaking HTTP with the token from StartSession. */
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
    expect(
      (
        await this.request("/mod/hello", {
          _tag: "ModHello",
          protocolVersion: ProtocolVersion,
          sessionId: this.sessionId,
          claudeSessionId: "claude-1",
          model: "claude-opus",
        })
      ).status,
    ).toBe(200)
  }

  async post(...messages: ReadonlyArray<ModEvent>) {
    expect((await this.request("/mod/events", { messages })).status).toBe(204)
  }

  async poll(waitMs = 0): Promise<Array<Command>> {
    const response = await this.request(`/mod/commands?after=${this.after}&waitMs=${waitMs}`)
    const body = (await response.json()) as ModCommandsEncoded
    this.after = body.messages.at(-1)?.seq ?? this.after
    return body.messages.map((command) => command.message)
  }
}

const turnStarted = (turnId: string, promptId?: string): ModEvent => ({
  _tag: "TurnStarted",
  turnId,
  text: "",
  sender: { _tag: "FromTerminal" },
  ...(promptId !== undefined && { promptId }),
})
const turnEnded = (turnId: string): ModEvent => ({
  _tag: "TurnEnded",
  turnId,
  reason: "Answered",
  durationMs: 10,
})

type Web = Awaited<ReturnType<typeof openWeb>>

/** alice starts a Session on the Runner, which says it started; returns it and its mod. */
async function startSession(hub: TestHub, web: Web, runner: Connection<ToRunner>, n: number) {
  web.send({ _tag: "CreateSession", requestId: `create-${n}`, repo, baseBranch: "main" })
  const start = await runner.take("StartSession")
  const created = await web.take("SessionCreated", (m) => m.requestId === `create-${n}`)
  const sessionId = created.session.id
  const mod = new Mod(hub, sessionId, start.modToken)
  await mod.hello()
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === sessionId && !m.session.starting)
  return { sessionId, mod }
}

/** The Runner's entry in the next RunnerList that matches. */
async function listed(web: Web, where: (runner: Web["runners"]["runners"][number]) => boolean) {
  const list = await web.take("RunnerList", (m) => m.runners.some(where))
  return list.runners.find(where)
}

/**
 * A Hub with alice on the web and a Runner that updates itself, connected on the Hub's commit to
 * start `sessions` Sessions, then back behind the Hub, as after the Hub was updated.
 */
async function behindScene(sessions: number, more: Record<string, unknown> = selfUpdating) {
  const hub = await updatesHub()
  const token = (await issueRunnerToken(hub, "studio")).token
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  const first = await openRunner(hub, token, [], hubCommit, true, more)
  const started = []
  for (let n = 0; n < sessions; n++) started.push(await startSession(hub, web, first, n))
  await first.close()
  await web.take("RunnerList", (m) => m.runners[0]?.isOnline === false)
  const ids = started.map((session) => session.sessionId)
  const runner = await openRunner(hub, token, ids, olderCommit, true, more)
  const entry = await listed(web, (r) => r.isOnline && r.versionStatus === "Behind")
  return { hub, web, token, runner, sessions: started, runnerId: entry?.id ?? "" }
}

describe("a Runner behind the Hub", () => {
  test("keeps its running Sessions, but no Session starts or wakes there", async () => {
    const { hub, web, runner, sessions } = await behindScene(1)
    const [{ sessionId, mod }] = sessions as [(typeof sessions)[number]]
    await web.take(
      "SessionUpdated",
      (m) => m.session.id === sessionId && m.session.state === "Active",
    )

    // Its running Session goes on taking prompts.
    web.send({ _tag: "JoinSession", sessionId })
    web.send({ _tag: "SendPrompt", sessionId, text: "one" })
    const delivered = (await mod.poll(500)).find((c) => c._tag === "DeliverPrompt")
    expect(delivered).toMatchObject({ text: "one" })
    await mod.post(
      turnStarted("t-1", delivered?._tag === "DeliverPrompt" ? delivered.promptId : ""),
      turnEnded("t-1"),
    )
    await web.take("PromptQueueChanged", (m) => m.queue.length === 0)

    web.send({ _tag: "CreateSession", requestId: "create-new", repo, baseBranch: "main" })
    expect(await web.take("CommandFailed", (m) => m.command === "CreateSession")).toMatchObject({
      requestId: "create-new",
      message: "studio: this Runner needs an update. Update it on the Runners page.",
    })

    // Put to sleep, it isn't woken.
    web.send({ _tag: "SleepSession", sessionId })
    await runner.take("StopSession")
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    await web.take(
      "SessionUpdated",
      (m) => m.session.id === sessionId && m.session.state === "Asleep",
    )
    web.send({ _tag: "WakeSession", sessionId })
    expect(await web.take("CommandFailed", (m) => m.command === "WakeSession")).toMatchObject({
      sessionId,
      message: "studio: this Runner needs an update. Update it on the Runners page.",
    })
    // A prompt waits in its queue, for the Runner to be updated.
    web.send({ _tag: "SendPrompt", sessionId, text: "two" })
    expect(await web.take("CommandFailed", (m) => m.command === "SendPrompt")).toMatchObject({
      message: expect.stringContaining("Your prompt waits in the queue."),
    })
    await web.take("PromptQueueChanged", (m) => m.queue.some((p) => p.text === "two"))
    expect(await runner.untaken("StartSession")).toEqual([])
    void hub
  })
})

describe("updating a Runner", () => {
  test("drains its Sessions as their Turns end, moves it, and settles once it is back", async () => {
    const { hub, web, token, runner, sessions, runnerId } = await behindScene(2)
    const [idle, busy] = sessions as [(typeof sessions)[number], (typeof sessions)[number]]
    await busy.mod.post(turnStarted("t-1"))
    await web.take(
      "SessionUpdated",
      (m) => m.session.id === busy.sessionId && m.session.currentTurn === "t-1",
    )

    web.send({ _tag: "UpdateRunner", requestId: "u-1", runnerId, now: false })
    expect(await web.take("RunnerUpdateRequested")).toEqual({
      _tag: "RunnerUpdateRequested",
      requestId: "u-1",
      runnerId,
    })
    expect(await runner.take("CheckUpdate")).toEqual({ _tag: "CheckUpdate", target: hubCommit })
    expect((await listed(web, (r) => r.update?._tag === "Checking"))?.update).toMatchObject({
      target: hubCommit,
    })

    runner.send({ _tag: "UpdateChecked", target: hubCommit })
    // The idle Session goes to sleep at once; the busy one waits for its Turn.
    expect(await runner.take("StopSession")).toEqual({
      _tag: "StopSession",
      sessionId: idle.sessionId,
      reason: "Sleep",
    })
    const draining = (await listed(web, (r) => r.update?._tag === "Draining"))?.update
    expect(draining).toMatchObject({ target: hubCommit, now: false, waitingFor: 2 })
    runner.send({ _tag: "SessionStopped", sessionId: idle.sessionId, reason: "Requested" })
    await listed(web, (r) => r.update?._tag === "Draining" && r.update.waitingFor === 1)

    // Nothing new starts there meanwhile, and prompts wait.
    web.send({ _tag: "CreateSession", requestId: "create-new", repo, baseBranch: "main" })
    expect(await web.take("CommandFailed", (m) => m.command === "CreateSession")).toMatchObject({
      message:
        "studio: this Runner is updating. Sessions start and wake there again once it is back.",
    })
    web.send({ _tag: "JoinSession", sessionId: busy.sessionId })
    web.send({ _tag: "SendPrompt", sessionId: busy.sessionId, text: "after the update" })
    await web.take("PromptQueueChanged", (m) => m.queue.length === 1)

    await busy.mod.post(turnEnded("t-1"))
    expect(await runner.take("StopSession")).toMatchObject({ sessionId: busy.sessionId })
    expect((await busy.mod.poll()).filter((c) => c._tag === "DeliverPrompt")).toEqual([])
    runner.send({ _tag: "SessionStopped", sessionId: busy.sessionId, reason: "Requested" })

    expect(await runner.take("ApplyUpdate")).toEqual({ _tag: "ApplyUpdate", target: hubCommit })
    await listed(web, (r) => r.update?._tag === "Applying")
    runner.send({ _tag: "UpdateProgress", target: hubCommit, step: "Installing" })
    await listed(web, (r) => r.update?._tag === "Applying" && r.update.step === "Installing")

    // It restarts on the Hub's commit.
    await runner.close()
    await listed(web, (r) => !r.isOnline && r.update?._tag === "Restarting")
    const back = await openRunner(hub, token, [], hubCommit, true, selfUpdating)
    const done = await listed(web, (r) => r.isOnline && r.versionStatus === "Current")
    expect(done?.update).toBeUndefined()
    // The prompt that waited wakes its Session.
    expect(await back.take("StartSession")).toMatchObject({ sessionId: busy.sessionId })
  })

  test("now stops running Turns at once, as asked by whoever asked", async () => {
    const { web, runner, sessions, runnerId } = await behindScene(1)
    const [busy] = sessions as [(typeof sessions)[number]]
    await busy.mod.post(turnStarted("t-1"))
    await web.take("SessionUpdated", (m) => m.session.currentTurn === "t-1")
    web.send({ _tag: "JoinSession", sessionId: busy.sessionId })
    await web.take("SessionHistory")

    web.send({ _tag: "UpdateRunner", requestId: "u-1", runnerId, now: false })
    await runner.take("CheckUpdate")
    runner.send({ _tag: "UpdateChecked", target: hubCommit })
    await listed(web, (r) => r.update?._tag === "Draining")
    expect((await busy.mod.poll()).filter((c) => c._tag === "StopTurn")).toEqual([])

    // "Update now" while it waits.
    web.send({ _tag: "UpdateRunner", requestId: "u-2", runnerId, now: true })
    await web.take("RunnerUpdateRequested", (m) => m.requestId === "u-2")
    await listed(web, (r) => r.update?._tag === "Draining" && r.update.now)
    expect(await busy.mod.poll(500)).toContainEqual({ _tag: "StopTurn", sessionId: busy.sessionId })
    expect(
      (await web.take("SessionEventLogged", (m) => m.entry.event._tag === "TurnStopRequested"))
        .entry.event,
    ).toEqual({ _tag: "TurnStopRequested", by: alice })

    await busy.mod.post(turnEnded("t-1"))
    await runner.take("StopSession")
    runner.send({ _tag: "SessionStopped", sessionId: busy.sessionId, reason: "Requested" })
    await runner.take("ApplyUpdate")
  })

  test("shows a Runner's refusal, and drains nothing", async () => {
    const { web, runner, runnerId } = await behindScene(1)
    web.send({ _tag: "UpdateRunner", requestId: "u-1", runnerId, now: false })
    await runner.take("CheckUpdate")
    const refusal = {
      reason: "NotOnMain",
      message: `${hubCommit.commit.slice(0, 7)} is not on origin/main`,
    }
    runner.send({ _tag: "UpdateChecked", target: hubCommit, refusal })
    expect((await listed(web, (r) => r.update?._tag === "Refused"))?.update).toMatchObject({
      _tag: "Refused",
      target: hubCommit,
      refusal,
    })
    expect(await runner.untaken("StopSession")).toEqual([])
  })

  test("shows a failed update, rolled back, and lets it be tried again", async () => {
    const { web, runner, runnerId } = await behindScene(0)
    web.send({ _tag: "UpdateRunner", requestId: "u-1", runnerId, now: false })
    await runner.take("CheckUpdate")
    runner.send({ _tag: "UpdateChecked", target: hubCommit })
    await runner.take("ApplyUpdate")
    const failure = {
      target: hubCommit,
      message: "bun install failed: exit code 1",
      rolledBack: true,
      at: 1_000,
    }
    runner.send({ _tag: "UpdateFailed", failure })
    expect((await listed(web, (r) => r.update?._tag === "Failed"))?.update).toEqual({
      _tag: "Failed",
      failure,
    })

    web.send({ _tag: "UpdateRunner", requestId: "u-2", runnerId, now: false })
    await web.take("RunnerUpdateRequested", (m) => m.requestId === "u-2")
    await runner.take("CheckUpdate")
  })

  test("hears of a failed update from the hello, after the Runner restarted", async () => {
    const { hub, web, token, runner, runnerId } = await behindScene(0)
    web.send({ _tag: "UpdateRunner", requestId: "u-1", runnerId, now: false })
    await runner.take("CheckUpdate")
    runner.send({ _tag: "UpdateChecked", target: hubCommit })
    await runner.take("ApplyUpdate")
    await runner.close()
    await listed(web, (r) => r.update?._tag === "Restarting")

    const lastUpdate = {
      target: hubCommit,
      message: "The new commit didn't start: rolled back",
      rolledBack: true,
      at: 2_000,
    }
    await openRunner(hub, token, [], olderCommit, true, { ...selfUpdating, lastUpdate })
    const entry = await listed(web, (r) => r.isOnline && r.update?._tag === "Failed")
    expect(entry).toMatchObject({ versionStatus: "Behind", update: { failure: lastUpdate } })
  })

  test("is refused for a Runner that doesn't update itself, or is too old to", async () => {
    const manual = await behindScene(0, {
      updater: { self: false, reason: "it runs from a developer's checkout" },
    })
    manual.web.send({
      _tag: "UpdateRunner",
      requestId: "u-1",
      runnerId: manual.runnerId,
      now: false,
    })
    expect(await manual.web.take("CommandFailed")).toMatchObject({
      command: "UpdateRunner",
      requestId: "u-1",
      message: "studio doesn't update itself: it runs from a developer's checkout.",
    })
    const listedManual = await openWeb(manual.hub, "bob")
    expect(listedManual.runners.runners[0]?.updater).toEqual({
      self: false,
      reason: "it runs from a developer's checkout",
    })

    const old = await behindScene(0, {})
    old.web.send({ _tag: "UpdateRunner", requestId: "u-2", runnerId: old.runnerId, now: false })
    expect((await old.web.take("CommandFailed")).message).toContain("too old to update itself")
  })
})

describe("claude-hub update's push", () => {
  test("tells Runners that update themselves to follow as they connect behind the Hub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-"))
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await updatesHub(database)
      const studio = await issueRunnerToken(first, "studio")
      const laptop = await issueRunnerToken(first, "laptop")
      // As `claude-hub update --no-update-runners` leaves it: only the Runner on its machine.
      await first.run(
        Effect.flatMap(RunnerUpdatePush, (push) =>
          push.request(
            {
              commit: hubCommit.commit,
              now: true,
              allRunners: false,
              localRunner: studio.runnerId,
            },
            1,
          ),
        ),
      )
      await first.stop()

      const hub = await updatesHub(database)
      const local = await openRunner(hub, studio.token, [], olderCommit, true, selfUpdating)
      expect(await local.take("CheckUpdate")).toEqual({ _tag: "CheckUpdate", target: hubCommit })
      const other = await openRunner(hub, laptop.token, [], olderCommit, true, selfUpdating)
      expect(await other.untaken("CheckUpdate")).toEqual([])
      const web = await openWeb(hub, "alice")
      const entry = web.runners.runners.find((r) => r.name === "studio")
      expect(entry?.update).toMatchObject({ _tag: "Checking", target: hubCommit })

      // Moved on the push, it drains with update now.
      local.send({ _tag: "UpdateChecked", target: hubCommit })
      await local.take("ApplyUpdate")
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a Runner turned away for its protocol version", () => {
  test("hears the Hub's commit, in a shape every version reads", async () => {
    const hub = await updatesHub()
    const { token } = await issueRunnerToken(hub, "studio")
    const runner = await Connection.open<ToRunner>(hub, "/ws/runner", bearer(token), {
      _tag: "RunnerHello",
      protocolVersion: ProtocolVersion + 1,
      somethingNew: true,
    })
    const rejected = await runner.take("HandshakeRejected")
    expect(rejected).toEqual({
      _tag: "HandshakeRejected",
      reason: "ProtocolVersionMismatch",
      protocolVersion: ProtocolVersion,
      message: expect.stringContaining("Protocol version mismatch"),
      hubVersion: hubCommit,
    })
    expect((await runner.closed).code).toBe(1008)
  })
})
