// `claude-hub forward`'s connection to the Hub (#180, ADR 0016), end to end: a real Hub, a fake
// Runner, the web UI and forwards over WebSockets as the CLI opens them.

import { afterEach, describe, expect, test } from "bun:test"
import {
  ForwardCloseCode,
  type HubToForward,
  Participant,
  ParticipantId,
  ProtocolVersion,
} from "@claude-hub/protocol"
import { Effect } from "effect"
import { CliTokens, pkceChallenge } from "./CliTokens.ts"
import { Connection, issueRunnerToken, openRunner, openWeb, stopAll } from "./testChannels.ts"
import { bearer, devSignIn, seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/claude-hub"

type Forwarded = typeof HubToForward.Encoded

const ports = [
  { port: 3000, addresses: ["127.0.0.1"], process: "bun server" },
  { port: 5173, addresses: ["::1"], process: "node vite" },
]

/** A CLI token for `login`, as `claude-hub login` on `machine` gets one. */
const cliToken = (hub: TestHub, login: string, machine: string) =>
  hub.run(
    Effect.gen(function* () {
      const cli = yield* CliTokens
      const verifier = "v".repeat(43)
      const who = Participant.make({ id: ParticipantId.make(`dev:${login}`), login, name: login })
      const { code } = yield* cli.approve(who, machine, pkceChallenge(verifier))
      return yield* cli.redeem(code, verifier)
    }),
  )

/** A Hub with an online Runner, and an Active Session of `repo` with two Open ports, alice's. */
async function forwardScene(hub?: TestHub) {
  const theHub = hub ?? (await startHub({ config: { devLogin: true } }))
  const runnerToken = (await issueRunnerToken(theHub)).token
  const runner = await openRunner(theHub, runnerToken, [], undefined, true, { forwardsPorts: true })
  const web = await openWeb(theHub, "alice")
  await seedEnvironment(theHub, repo, "dev:alice")
  web.send({ _tag: "CreateSession", requestId: "req-1", repo, baseBranch: "main" })
  const start = await runner.take("StartSession")
  const sessionId = (await web.take("SessionCreated")).session.id
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === sessionId && !m.session.starting)
  runner.send({ _tag: "SessionPorts", sessionId, ports })
  await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
  const laptop = await cliToken(theHub, "alice", "laptop")
  return { hub: theHub, runner, runnerToken, web, sessionId, start, laptop }
}

type Scene = Awaited<ReturnType<typeof forwardScene>>

/** A forward of the Session, as the CLI opens it, welcomed. */
async function openForward(hub: TestHub, sessionId: string, token: string) {
  const forward = await Connection.open<Forwarded>(hub, `/ws/forward/${sessionId}`, bearer(token), {
    _tag: "ForwardHello",
    protocolVersion: ProtocolVersion,
  })
  await forward.take("ForwardWelcome")
  return forward
}

/** Puts the Session to sleep from the web, playing the Runner's part. */
async function putToSleep(scene: Scene) {
  scene.web.send({ _tag: "SleepSession", sessionId: scene.sessionId })
  await scene.runner.take("StopSession")
  scene.runner.send({
    _tag: "SessionStopped",
    sessionId: scene.sessionId,
    reason: "Requested",
    exitCode: 143,
  })
  await scene.web.take("SessionUpdated", (m) => m.session.state === "Asleep")
}

/** The status an upgrade to `path` is answered with, by fetch: 101 shows as a failed fetch. */
async function upgradeStatus(hub: TestHub, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${hub.url}${path}`, {
    headers: {
      ...headers,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": btoa("0123456789abcdef"),
    },
  }).catch(() => undefined)
  return response?.status ?? 101
}

describe("the forward endpoint", () => {
  test("is a WebSocket, for a CLI token only", async () => {
    const { hub, sessionId, web, laptop } = await forwardScene()
    const path = `/ws/forward/${sessionId}`
    expect((await fetch(`${hub.url}${path}`)).status).toBe(426)
    expect(await upgradeStatus(hub, path)).toBe(401)
    expect(await upgradeStatus(hub, path, bearer("chc_not.a-token"))).toBe(401)
    // A browser's sign-in won't do: a forward is a machine's.
    expect(await upgradeStatus(hub, path, { cookie: web.cookie })).toBe(401)
    const forward = await openForward(hub, sessionId, laptop.token)
    expect((await forward.take("ForwardSession")).session.openPorts).toEqual(ports)
  })

  test("refuses a Session that doesn't exist, or one in a Repo the caller has no access to, alike", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    await devSignIn(hub, "alice")
    const token = (await cliToken(hub, "alice", "laptop")).token
    const nowhere = await Connection.open<Forwarded>(
      hub,
      "/ws/forward/no-such-session",
      bearer(token),
      { _tag: "ForwardHello", protocolVersion: ProtocolVersion },
    )
    expect(await nowhere.closed).toEqual({
      code: ForwardCloseCode.NoSuchSession,
      reason: "There is no such Session.",
    })
  })

  test("sends the Session as its Open ports change, and shows as presence named after the machine", async () => {
    const scene = await forwardScene()
    const { hub, runner, web, sessionId, laptop } = scene
    web.send({ _tag: "JoinSession", sessionId })
    await web.take("PresenceChanged", (m) => m.participants.length === 1)

    const forward = await openForward(hub, sessionId, laptop.token)
    await forward.take("ForwardSession", (m) => m.session.openPorts?.length === 2)
    const present = await web.take("PresenceChanged", (m) =>
      m.participants.some((p) => p.forwardingFrom !== undefined),
    )
    expect(present.participants).toEqual([
      { id: "dev:alice", login: "alice", name: "alice", forwardingFrom: ["laptop"] },
    ])

    // A port that opens later, and one that closes.
    runner.send({
      _tag: "SessionPorts",
      sessionId,
      ports: [ports[1], { port: 8080, addresses: ["0.0.0.0"] }],
    })
    const changed = await forward.take(
      "ForwardSession",
      (m) => m.session.openPorts?.some((p) => p.port === 8080) === true,
    )
    expect(changed.session.openPorts?.map((p) => p.port)).toEqual([5173, 8080])

    // Two machines of one person, and someone forwarding without being in it on the web.
    const desktop = await cliToken(hub, "alice", "desktop")
    const second = await openForward(hub, sessionId, desktop.token)
    await web.take("PresenceChanged", (m) => m.participants[0]?.forwardingFrom?.length === 2)
    // bob signs in on the web once, as anyone with a CLI token has.
    await openWeb(hub, "bob")
    const bob = await openForward(hub, sessionId, (await cliToken(hub, "bob", "bobs-mac")).token)
    const three = await web.take("PresenceChanged", (m) => m.participants.length === 2)
    expect(three.participants.map((p) => [p.login, p.forwardingFrom])).toEqual([
      ["alice", ["laptop", "desktop"]],
      ["bob", ["bobs-mac"]],
    ])

    // Disconnecting takes it out of presence.
    await second.close()
    await bob.close()
    await forward.close()
    const after = await web.take("PresenceChanged", (m) =>
      m.participants.every((p) => p.forwardingFrom === undefined),
    )
    expect(after.participants).toEqual([{ id: "dev:alice", login: "alice", name: "alice" }])
  })

  test("keeps the Session awake while it is connected", async () => {
    const scene = await forwardScene(
      await startHub({ config: { devLogin: true, sleepAfterMs: 150 } }),
    )
    const forward = await openForward(scene.hub, scene.sessionId, scene.laptop.token)
    await Bun.sleep(500)
    expect(await scene.runner.untaken("StopSession")).toEqual([])
    await forward.close()
    expect(await scene.runner.take("StopSession")).toMatchObject({
      sessionId: scene.sessionId,
      reason: "Sleep",
    })
  })

  test("is closed when the Session is put to sleep, saying it went asleep and why", async () => {
    const scene = await forwardScene()
    scene.web.send({ _tag: "JoinSession", sessionId: scene.sessionId })
    const forward = await openForward(scene.hub, scene.sessionId, scene.laptop.token)
    await forward.take("ForwardSession")
    await putToSleep(scene)
    expect(await forward.closed).toEqual({
      code: ForwardCloseCode.WentAsleep,
      reason: "Put to sleep by alice",
    })
    const gone = await scene.web.take("PresenceChanged", (m) =>
      m.participants.every((p) => p.forwardingFrom === undefined),
    )
    expect(gone.participants).toEqual([{ id: "dev:alice", login: "alice", name: "alice" }])
  })

  test("wakes an Asleep Session", async () => {
    const scene = await forwardScene()
    await putToSleep(scene)
    const forward = await openForward(scene.hub, scene.sessionId, scene.laptop.token)
    expect(await scene.runner.take("StartSession")).toMatchObject({ sessionId: scene.sessionId })
    expect((await forward.take("ForwardSession")).session.state).toBe("Active")
    // It isn't closed for the wake.
    scene.runner.send({ _tag: "SessionStarted", sessionId: scene.sessionId, environmentVersion: 1 })
    await forward.take("ForwardSession", (m) => m.session.starting === undefined)
  })

  test("says why an Asleep Session can't wake, and waits out a Frozen one", async () => {
    const scene = await forwardScene()
    await putToSleep(scene)
    await scene.runner.close()
    await scene.web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    // While its Runner is offline, the forward stays, and says so.
    const frozen = await openForward(scene.hub, scene.sessionId, scene.laptop.token)
    expect((await frozen.take("ForwardSession")).session.state).toBe("Frozen")
    await frozen.close()

    // Back without a Claude credential of its own, and alice has stored none.
    await openRunner(scene.hub, scene.runnerToken, [], undefined, true, {
      forwardsPorts: true,
      ownClaudeCredential: false,
    })
    await scene.web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    const forward = await Connection.open<Forwarded>(
      scene.hub,
      `/ws/forward/${scene.sessionId}`,
      bearer(scene.laptop.token),
      { _tag: "ForwardHello", protocolVersion: ProtocolVersion },
    )
    expect(await forward.closed).toEqual({
      code: ForwardCloseCode.WentAsleep,
      reason:
        "Claude Code could not start: Neither you nor mac has a Claude credential: add yours on the Account page.",
    })
  })

  test("is closed when the CLI token is revoked, from the web or by logout", async () => {
    const scene = await forwardScene()
    const forward = await openForward(scene.hub, scene.sessionId, scene.laptop.token)
    await forward.take("ForwardSession")
    scene.web.send({ _tag: "RevokeCliToken", requestId: "r", cliTokenId: scene.laptop.id })
    expect(await forward.closed).toEqual({
      code: ForwardCloseCode.SignedOut,
      reason: "This machine's CLI token was revoked: run claude-hub login to sign in again.",
    })

    const desktop = await cliToken(scene.hub, "alice", "desktop")
    const again = await openForward(scene.hub, scene.sessionId, desktop.token)
    await again.take("ForwardSession")
    const out = await fetch(`${scene.hub.url}/auth/cli/sign-out`, {
      method: "POST",
      headers: bearer(desktop.token),
    })
    expect(out.status).toBe(204)
    expect((await again.closed).code).toBe(ForwardCloseCode.SignedOut)
  })

  test("is closed when the Session is archived", async () => {
    const scene = await forwardScene()
    const forward = await openForward(scene.hub, scene.sessionId, scene.laptop.token)
    await forward.take("ForwardSession")
    scene.web.send({ _tag: "ArchiveSession", requestId: "r", sessionId: scene.sessionId })
    expect(await forward.closed).toEqual({
      code: ForwardCloseCode.Archived,
      reason: "The Session was archived.",
    })
  })
})

describe("the Sessions forward picks from", () => {
  test("are the caller's that aren't Archived, newest first, as the web sees them", async () => {
    const scene = await forwardScene()
    const list = await fetch(`${scene.hub.url}/auth/cli/sessions`, {
      headers: bearer(scene.laptop.token),
    })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { sessions: Array<{ id: string; openPorts?: unknown }> }
    expect(body.sessions.map((s) => s.id)).toEqual([scene.sessionId])
    expect(body.sessions[0]?.openPorts).toEqual(ports)
    expect((await fetch(`${scene.hub.url}/auth/cli/sessions`)).status).toBe(401)
  })
})
