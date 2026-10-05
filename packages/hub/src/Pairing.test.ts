// Pairing codes and the Runners page, end to end (issue #85): a real Hub, web clients and fake
// Runners over WebSockets, and `runner join`'s requests over HTTP.

import { afterEach, describe, expect, test } from "bun:test"
import { PairingCodeRefused } from "@claude-hub/protocol"
import { HubVersion } from "./HubVersion.ts"
import { RunnerGoneCloseCode } from "./RunnerRelay.ts"
import { openRunner, openWeb, runnerLogin, stopAll } from "./testChannels.ts"
import { bearer, seedEnvironment, startHub, type TestHub, webOrigin } from "./testSupport.ts"

afterEach(stopAll)

const hubCommit = { commit: "a".repeat(40), branch: "main" }
const olderCommit = { commit: "b".repeat(40) }

/** A Hub at hubCommit, whose history holds olderCommit, with dev login. */
const pairingHub = () =>
  startHub({
    config: { devLogin: true },
    hubVersion: HubVersion.fixed(hubCommit, (commit) => commit === olderCommit.commit),
  })

const pair = (hub: TestHub, body: unknown) =>
  fetch(`${hub.url}/runner/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const connection = (hub: TestHub, token: string) =>
  fetch(`${hub.url}/runner/connection`, { headers: bearer(token) })

/** alice mints a code on the Runners page, for a new Runner or to Re-pair `runnerId`. */
async function mint(
  web: Awaited<ReturnType<typeof openWeb>>,
  requestId: string,
  runnerId?: string,
) {
  web.send({ _tag: "CreatePairingCode", requestId, ...(runnerId && { runnerId }) })
  return web.take("PairingCodeCreated", (m) => m.requestId === requestId)
}

/** Redeems a code the way `runner join` does, and returns the Runner and its token. */
async function redeem(hub: TestHub, code: string, name = "studio") {
  const response = await pair(hub, { code, name })
  expect(response.status).toBe(200)
  return (await response.json()) as {
    runnerId: string
    name: string
    token: string
    repaired: boolean
  }
}

describe("Add a Runner", () => {
  test("gives a one-paste link with the Hub's URL, and lists the code, without it, to everyone", async () => {
    const hub = await pairingHub()
    const alice = await openWeb(hub, "alice")
    const bob = await openWeb(hub, "bob")
    expect(alice.pairingCodes.codes).toEqual([])

    const created = await mint(alice, "q-1")

    expect(created.link).toBe(`${webOrigin}#${created.code}`)
    expect(created.code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
    const listed = await bob.take("PairingCodeList", (m) => m.codes.length === 1)
    expect(listed.codes[0]).toMatchObject({
      id: created.id,
      createdBy: { login: "alice" },
      expiresAt: created.expiresAt,
    })
    expect(JSON.stringify(listed)).not.toContain(created.code)
  })

  test("pairs a machine: a lasting token it connects with, listed with its version", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    const created = await mint(web, "q-1")

    // As `runner join` sends it: lower case, from the link.
    const paired = await redeem(hub, created.code.toLowerCase(), "studio")
    expect(paired).toMatchObject({ name: "studio", repaired: false })
    expect(paired.token.startsWith("chr_")).toBe(true)
    await web.take("PairingCodeList", (m) => m.codes.length === 0)
    const offline = await web.take("RunnerList", (m) => m.runners.length === 1)
    expect(offline.runners[0]).toEqual({
      id: paired.runnerId,
      name: "studio",
      login: null,
      isOnline: false,
      version: null,
      versionStatus: "Unknown",
      lastSeenAt: null,
      openSessions: 0,
    })
    expect(await (await connection(hub, paired.token)).json()).toEqual({
      runnerId: paired.runnerId,
      name: "studio",
      online: false,
    })

    const runner = await openRunner(hub, paired.token, [], olderCommit)
    const online = await web.take("RunnerList", (m) => m.runners[0]?.isOnline === true)
    expect(online.runners[0]).toMatchObject({
      login: runnerLogin,
      version: olderCommit,
      versionStatus: "Behind",
      openSessions: 0,
    })
    expect(online.runners[0]?.lastSeenAt).toBeNumber()
    expect(await (await connection(hub, paired.token)).json()).toMatchObject({ online: true })

    await runner.close()
    const gone = await web.take("RunnerList", (m) => m.runners[0]?.isOnline === false)
    expect(gone.runners[0]?.lastSeenAt).toBeNumber()
  })

  test("lists a Runner on the Hub's commit as Current, and one too old to say as Unknown", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    const current = await redeem(hub, (await mint(web, "q-1")).code, "current")
    const old = await redeem(hub, (await mint(web, "q-2")).code, "old")
    await openRunner(hub, current.token, [], hubCommit)
    // A Runner from before #85 says no version, and still connects.
    await openRunner(hub, old.token)

    const list = await web.take("RunnerList", (m) => m.runners.every((r) => r.isOnline))
    expect(list.runners.map((r) => [r.name, r.versionStatus])).toEqual([
      ["current", "Current"],
      ["old", "Unknown"],
    ])
  })

  test("refuses a code it doesn't know, or one used, alike, and a body that isn't one", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    const created = await mint(web, "q-1")
    await redeem(hub, created.code)

    for (const code of [created.code, "ABCDE-ABCDE-ABCDE-ABCDE", "short"]) {
      const response = await pair(hub, { code, name: "other" })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: PairingCodeRefused })
    }
    expect((await pair(hub, "not json")).status).toBe(400)
    expect((await pair(hub, { code: created.code })).status).toBe(400)
  })

  test("refuses a name in use, saying how to go on, and keeps the code", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    await redeem(hub, (await mint(web, "q-1")).code, "studio")
    const created = await mint(web, "q-2")

    const taken = await pair(hub, { code: created.code, name: "studio" })
    expect(taken.status).toBe(409)
    expect(((await taken.json()) as { error: string }).error).toContain("--name")

    expect((await redeem(hub, created.code, "studio-2")).name).toBe("studio-2")
  })

  test("revoking a code makes it unusable, and tells everyone", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    const created = await mint(web, "q-1")
    web.send({ _tag: "RevokePairingCode", requestId: "q-2", pairingCodeId: created.id })

    expect(await web.take("PairingCodeList", (m) => m.requestId === "q-2")).toMatchObject({
      codes: [],
    })
    expect((await pair(hub, { code: created.code, name: "studio" })).status).toBe(403)
  })
})

describe("Re-pair", () => {
  test("keeps the RunnerId, replaces the token, and disconnects the Runner on the old one", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    const first = await redeem(hub, (await mint(web, "q-1")).code, "studio")
    const old = await openRunner(hub, first.token)
    await web.take("RunnerList", (m) => m.runners[0]?.isOnline === true)

    const created = await mint(web, "q-2", first.runnerId)
    expect(created.runnerId).toBe(first.runnerId)
    const again = await redeem(hub, created.code, "whatever")

    expect(again).toMatchObject({ runnerId: first.runnerId, name: "studio", repaired: true })
    expect(await old.closed).toMatchObject({ code: RunnerGoneCloseCode.Repaired })
    expect((await connection(hub, first.token)).status).toBe(401)
    await openRunner(hub, again.token)
    const list = await web.take("RunnerList", (m) => m.runners[0]?.isOnline === true)
    expect(list.runners.map((r) => r.id)).toEqual([first.runnerId])
  })
})

/** A paired, connected Runner with one Session alice started on it. */
async function runnerWithSession() {
  const hub = await pairingHub()
  const web = await openWeb(hub, "alice")
  const paired = await redeem(hub, (await mint(web, "q-1")).code, "studio")
  const runner = await openRunner(hub, paired.token)
  await seedEnvironment(hub, "kddige/claude-hub", "dev:alice")
  web.send({
    _tag: "CreateSession",
    requestId: "q-2",
    repo: "kddige/claude-hub",
    baseBranch: "main",
  })
  await runner.take("StartSession")
  const created = await web.take("SessionCreated")
  return { hub, web, paired, runner, sessionId: created.session.id }
}

describe("Remove", () => {
  test("is refused while the Runner has Sessions that aren't Archived", async () => {
    const { web, paired } = await runnerWithSession()
    const list = await web.take("RunnerList", (m) => m.runners[0]?.openSessions === 1)
    expect(list.runners[0]?.openSessions).toBe(1)

    web.send({ _tag: "RemoveRunner", requestId: "q-3", runnerId: paired.runnerId })

    expect(await web.take("CommandFailed", (m) => m.requestId === "q-3")).toMatchObject({
      command: "RemoveRunner",
      message:
        "Runner studio has 1 Session that isn't Archived. Archive it first, then remove the Runner.",
    })
  })

  test("once they are, revokes its token, disconnects it, and drops it from the list", async () => {
    const { hub, web, paired, runner, sessionId } = await runnerWithSession()
    const repair = await mint(web, "q-3", paired.runnerId)
    web.send({ _tag: "ArchiveSession", sessionId })
    await web.take("SessionUpdated", (m) => m.session.state === "Archived")

    web.send({ _tag: "RemoveRunner", requestId: "q-4", runnerId: paired.runnerId })

    expect(await web.take("RunnerRemoved")).toEqual({
      _tag: "RunnerRemoved",
      requestId: "q-4",
      runnerId: paired.runnerId,
    })
    expect(await runner.closed).toMatchObject({ code: RunnerGoneCloseCode.Removed })
    await web.take("RunnerList", (m) => m.runners.length === 0)
    expect((await connection(hub, paired.token)).status).toBe(401)
    // Its Re-pair code went with it.
    expect((await pair(hub, { code: repair.code, name: "studio" })).status).toBe(403)

    // Its Archived Session can't come back on a Runner that is gone.
    web.send({ _tag: "RestoreSession", sessionId })
    expect(await web.take("CommandFailed", (m) => m.command === "RestoreSession")).toMatchObject({
      message: "The Session's Runner was removed from the Hub, so it can't be restored.",
    })
  })

  test("of a Runner there isn't is refused", async () => {
    const hub = await pairingHub()
    const web = await openWeb(hub, "alice")
    web.send({ _tag: "RemoveRunner", requestId: "q-1", runnerId: "nope" })
    expect(await web.take("CommandFailed")).toMatchObject({ message: "There is no such Runner." })
  })
})
