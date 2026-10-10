// Attachments (#276, ADR 0024): a Participant uploads a file to a Session over HTTP, sends a
// prompt naming it, and the Session's mod fetches it for Claude. A real Hub, a fake Runner and
// web clients over WebSockets, and a fake mod over HTTP.

import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import {
  AttachmentId,
  type ModCommandsEncoded,
  type ModEventsEncoded,
  MaxImageBytes,
  MaxPdfBytes,
  ParticipantId,
  ProtocolVersion,
  SessionId,
} from "@kndl/protocol"
import { Duration, Effect, type Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { Attachments, unsentAttachmentLifetime } from "./Attachments.ts"
import { DatabaseTest, databaseAt } from "./Database.ts"
import { Sessions } from "./Sessions.ts"
import { issueRunnerToken, openRunner, openWeb, stopAll } from "./testChannels.ts"
import {
  bearer,
  seedEnvironment,
  startHub,
  type TestHub,
  testDatabaseDir,
  webOrigin,
} from "./testSupport.ts"

afterEach(stopAll)

type Command = ModCommandsEncoded["messages"][number]["message"]
type ModEvent = ModEventsEncoded["messages"][number]

/** A PNG's signature and a little more: what the Hub tells a PNG by. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7])
const pdf = new TextEncoder().encode("%PDF-1.7\n%\u00e2\u00e3\n1 0 obj\n<<>>\nendobj\n%%EOF\n")

/** A file of `size` bytes that starts as `head` does. */
const sized = (head: Uint8Array, size: number) => {
  const bytes = new Uint8Array(size)
  bytes.set(head)
  bytes.fill(7, head.byteLength)
  return bytes
}

/** A Session alice created, started, with its mod linked; and a way to upload to it. */
async function scene(database?: Layer.Layer<SqlClient.SqlClient, unknown>) {
  const hub = await startHub({ config: { devLogin: true }, ...(database && { database }) })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true)
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, "kddige/kndl", "dev:alice")
  web.send({
    _tag: "CreateSession",
    requestId: "req-1",
    repo: "kddige/kndl",
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  const start = await runner.take("StartSession")
  const sessionId = (await web.take("SessionCreated")).session.id
  const mod = modOf(hub, start.modToken)
  expect((await mod.hello(sessionId)).status).toBe(200)
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === sessionId && !m.session.starting)
  return { hub, web, runner, sessionId, mod }
}

/** The fake mod of a Session, with its mod token. */
function modOf(hub: TestHub, token: string) {
  let after = 0
  const request = (path: string, body?: unknown) =>
    fetch(`${hub.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    request,
    hello: (sessionId: string) =>
      request("/mod/hello", {
        _tag: "ModHello",
        protocolVersion: ProtocolVersion,
        sessionId,
        claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
        model: "claude-opus",
        steers: true,
      }),
    post: async (...messages: ReadonlyArray<ModEvent>) =>
      expect((await request("/mod/events", { messages })).status).toBe(204),
    /** The prompts delivered, waiting up to `waitMs` for one. */
    deliveries: async (waitMs = 2_000) => {
      const deadline = Date.now() + waitMs
      for (;;) {
        const wait = Math.max(0, deadline - Date.now())
        const response = await request(`/mod/commands?after=${after}&waitMs=${wait}`)
        const body = (await response.json()) as ModCommandsEncoded
        after = body.messages.at(-1)?.seq ?? after
        const found = body.messages
          .map((command) => command.message)
          .filter(
            (command): command is Extract<Command, { _tag: "DeliverPrompt" }> =>
              command._tag === "DeliverPrompt",
          )
        if (found.length > 0 || Date.now() >= deadline) return found
      }
    },
  }
}

const upload = (
  hub: TestHub,
  cookie: string,
  sessionId: string,
  bytes: Uint8Array,
  options: { readonly name?: string; readonly origin?: string; readonly type?: string } = {},
) =>
  fetch(`${hub.url}/sessions/${sessionId}/attachments`, {
    method: "POST",
    headers: {
      cookie,
      origin: options.origin ?? webOrigin,
      "content-type": options.type ?? "image/png",
      ...(options.name === undefined
        ? {}
        : { "x-kndl-filename": encodeURIComponent(options.name) }),
    },
    body: bytes,
  })

const uploaded = async (response: Response) => {
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}

describe("uploading an attachment", () => {
  test("keeps the image for the Session, served to its Participants as its bytes say", async () => {
    const { hub, web, sessionId } = await scene()
    const id = await uploaded(
      await upload(hub, web.cookie, sessionId, jpeg, { name: "shot.png", type: "image/png" }),
    )
    expect(id).toMatch(/^[0-9a-f]{32}$/)

    const bob = await openWeb(hub, "bob")
    const served = await fetch(`${hub.url}/sessions/${sessionId}/attachments/${id}`, {
      headers: { cookie: bob.cookie },
    })
    expect(served.status).toBe(200)
    // A JPEG, whatever it was sent as.
    expect(served.headers.get("content-type")).toBe("image/jpeg")
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")
    expect(served.headers.get("content-security-policy")).toBe("sandbox")
    expect(served.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg)
    expect(served.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''shot.png")

    // Saved under its name, whatever it holds.
    const named = await uploaded(
      await upload(hub, web.cookie, sessionId, png, { name: "Kjartan's shot (3).png" }),
    )
    const saved = await fetch(`${hub.url}/sessions/${sessionId}/attachments/${named}`, {
      headers: { cookie: bob.cookie },
    })
    expect(saved.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''Kjartan%27s%20shot%20%283%29.png",
    )
  })

  test("is refused past 5 MB, for what isn't an image Claude reads, and from another site", async () => {
    const { hub, web, sessionId } = await scene()
    const big = new Uint8Array(MaxImageBytes + 1)
    big.set(png)
    expect((await upload(hub, web.cookie, sessionId, big)).status).toBe(413)
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    expect((await upload(hub, web.cookie, sessionId, svg, { type: "image/svg+xml" })).status).toBe(
      415,
    )
    const elsewhere = await upload(hub, web.cookie, sessionId, png, {
      origin: "https://evil.test",
    })
    expect(elsewhere.status).toBe(403)
    expect((await upload(hub, "", sessionId, png)).status).toBe(401)
    expect((await upload(hub, web.cookie, "no-such-session", png)).status).toBe(404)
  })

  test("keeps a PDF of up to 10 MB, as its bytes say, served as a download (#277)", async () => {
    const { hub, web, sessionId } = await scene()
    const id = await uploaded(
      await upload(hub, web.cookie, sessionId, sized(pdf, MaxPdfBytes), {
        name: "spec.pdf",
        type: "application/octet-stream",
      }),
    )
    const served = await fetch(`${hub.url}/sessions/${sessionId}/attachments/${id}`, {
      headers: { cookie: web.cookie },
    })
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("application/pdf")
    expect(served.headers.get("content-security-policy")).toBe("sandbox")
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''spec.pdf")
    expect((await served.arrayBuffer()).byteLength).toBe(MaxPdfBytes)

    const unnamed = await uploaded(await upload(hub, web.cookie, sessionId, pdf))
    const fetched = await fetch(`${hub.url}/sessions/${sessionId}/attachments/${unnamed}`, {
      headers: { cookie: web.cookie },
    })
    expect(fetched.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''document.pdf",
    )
  })

  test("has a limit for its kind: 10 MB for a PDF, 5 MB for an image (#277)", async () => {
    const { hub, web, sessionId } = await scene()
    const bigPdf = await upload(hub, web.cookie, sessionId, sized(pdf, MaxPdfBytes + 1))
    expect(bigPdf.status).toBe(413)
    expect(await bigPdf.json()).toEqual({
      error: "An attachment may be 10 MB at most if a PDF, 5 MB if an image.",
    })
    // Under a PDF's limit, but an image.
    const bigImage = await upload(hub, web.cookie, sessionId, sized(png, MaxImageBytes + 1))
    expect(bigImage.status).toBe(413)
    expect(await bigImage.json()).toEqual({
      error: "An image may be 5 MB at most, the most Claude reads.",
    })
    const text = await upload(hub, web.cookie, sessionId, new TextEncoder().encode("hello"))
    expect(await text.json()).toEqual({
      error: "Only JPEG, PNG, GIF and WebP images and PDFs can be attached.",
    })
  })

  test("is refused for an Archived Session, which takes no prompts", async () => {
    const { hub, web, runner, sessionId } = await scene()
    web.send({ _tag: "ArchiveSession", sessionId })
    await runner.take("StopSession")
    await web.take("SessionUpdated", (m) => m.session.state === "Archived")
    expect((await upload(hub, web.cookie, sessionId, png)).status).toBe(409)
  })

  test("is served only to those who can see the Session", async () => {
    const { hub, web, sessionId } = await scene()
    const id = await uploaded(await upload(hub, web.cookie, sessionId, png))
    expect((await fetch(`${hub.url}/sessions/${sessionId}/attachments/${id}`)).status).toBe(401)
    expect(
      (
        await fetch(`${hub.url}/sessions/${sessionId}/attachments/nope`, {
          headers: { cookie: web.cookie },
        })
      ).status,
    ).toBe(404)
  })
})

describe("a prompt with attachments", () => {
  test("is queued and delivered with them; its Turn carries them for whoever joins later", async () => {
    const { hub, web, sessionId, mod } = await scene()
    const shot = await uploaded(await upload(hub, web.cookie, sessionId, png, { name: "shot.png" }))
    const photo = await uploaded(
      await upload(hub, web.cookie, sessionId, jpeg, { name: "my\nphoto[1].jpg" }),
    )
    web.send({ _tag: "SendPrompt", sessionId, text: "", attachments: [shot, photo] })

    const files = [
      { id: shot, name: "shot.png", mediaType: "image/png", size: png.byteLength },
      { id: photo, name: "my photo 1 .jpg", mediaType: "image/jpeg", size: jpeg.byteLength },
    ]
    const [delivered] = await mod.deliveries()
    expect(delivered).toMatchObject({ text: "", attachments: files })

    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-1",
      text: "[alice] [Image #1: shot.png (attachment …)]",
      sender: {
        _tag: "FromParticipant",
        participant: { id: "dev:alice", login: "alice", name: "alice" },
      },
      promptId: delivered?.promptId ?? "",
    })
    const later = await openWeb(hub, "bob")
    later.send({ _tag: "JoinSession", sessionId })
    const history = await later.take("SessionHistory")
    const started = history.entries.find((entry) => entry.event._tag === "TurnStarted")
    expect(started?.event).toMatchObject({ attachments: files })
  })

  test("carries a file named twice once", async () => {
    const { hub, web, sessionId, mod } = await scene()
    const shot = await uploaded(await upload(hub, web.cookie, sessionId, png, { name: "shot.png" }))
    web.send({ _tag: "SendPrompt", sessionId, text: "look", attachments: [shot, shot] })
    const [delivered] = await mod.deliveries()
    expect(delivered?.attachments?.map((file) => file.id)).toEqual([shot])
  })

  test("still queued, keeps its attachments over a Hub restart", async () => {
    const dir = testDatabaseDir("kndl-attachments-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await scene(database)
      const { web, runner, sessionId, mod } = first
      web.send({ _tag: "JoinSession", sessionId })
      await mod.post({
        _tag: "TurnStarted",
        turnId: "t-1",
        text: "go",
        sender: { _tag: "FromTerminal" },
      })
      const shot = await uploaded(
        await upload(first.hub, web.cookie, sessionId, png, { name: "shot.png" }),
      )
      web.send({ _tag: "SendPrompt", sessionId, text: "look", attachments: [shot] })
      await web.take("PromptQueueChanged", (m) => m.queue.length === 1)
      // And one left in the Composer.
      const unsent = await uploaded(await upload(first.hub, web.cookie, sessionId, png))
      await web.close()
      await runner.close()
      await first.hub.stop()

      // Back a day and an hour later: it sweeps as it starts.
      const second = await startHub({
        config: { devLogin: true },
        database,
        clockAhead: Duration.sum(unsentAttachmentLifetime, Duration.hours(1)),
      })
      const back = await openWeb(second, "alice", web.cookie)
      back.send({ _tag: "JoinSession", sessionId })
      const queue = await back.take("PromptQueueChanged", (m) => m.queue.length === 1)
      expect(queue.queue[0]?.attachments).toEqual([
        { id: shot, name: "shot.png", mediaType: "image/png", size: png.byteLength },
      ])
      const served = (id: string) =>
        fetch(`${second.url}/sessions/${sessionId}/attachments/${id}`, {
          headers: { cookie: web.cookie },
        }).then((response) => response.status)
      expect({ shot: await served(shot), unsent: await served(unsent) }).toEqual({
        shot: 200,
        unsent: 404,
      })
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("names only files its sender uploaded to this Session", async () => {
    const { hub, web, sessionId, mod } = await scene()
    const bob = await openWeb(hub, "bob")
    const bobs = await uploaded(await upload(hub, bob.cookie, sessionId, png))
    web.send({ _tag: "SendPrompt", sessionId, text: "look", attachments: [bobs] })
    expect((await web.take("CommandFailed")).message).toContain("attachment")
    web.send({ _tag: "SendPrompt", sessionId, text: "look", attachments: ["made-up"] })
    expect((await web.take("CommandFailed")).message).toContain("attachment")
    expect(await mod.deliveries(100)).toEqual([])
  })

  test("waits for the Turn to end rather than be steered into it", async () => {
    const { hub, web, sessionId, mod } = await scene()
    web.send({ _tag: "JoinSession", sessionId })
    await mod.post({
      _tag: "TurnStarted",
      turnId: "t-1",
      text: "go",
      sender: { _tag: "FromTerminal" },
    })
    await web.take("SessionUpdated", (m) => m.session.currentTurn !== null)
    const shot = await uploaded(await upload(hub, web.cookie, sessionId, png))
    web.send({ _tag: "SendPrompt", sessionId, text: "look", attachments: [shot] })
    const queued = await web.take("PromptQueueChanged", (m) => m.queue.length === 1)
    web.send({ _tag: "SteerPrompt", sessionId, promptId: queued.queue[0]?.id ?? "" })
    expect((await web.take("CommandFailed")).message).toContain("attachments")
  })
})

describe("the mod's attachment", () => {
  test("is the file, base64, for its own Session alone", async () => {
    const { hub, web, runner, sessionId, mod } = await scene()
    const id = await uploaded(await upload(hub, web.cookie, sessionId, png, { name: "shot.png" }))

    const fetched = await mod.request(`/mod/attachments/${id}`)
    expect(fetched.status).toBe(200)
    expect(await fetched.json()).toEqual({
      id,
      name: "shot.png",
      mediaType: "image/png",
      data: Buffer.from(png).toString("base64"),
    })

    web.send({
      _tag: "CreateSession",
      requestId: "req-2",
      repo: "kddige/kndl",
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    const other = modOf(hub, (await runner.take("StartSession")).modToken)
    expect((await other.request(`/mod/attachments/${id}`)).status).toBe(404)
    expect((await fetch(`${hub.url}/mod/attachments/${id}`)).status).toBe(401)
  })

  test("comes in parts the mod runtime's fetch can read, which join into the file", async () => {
    const { hub, web, sessionId, mod } = await scene()
    const big = sized(png, MaxImageBytes)
    const id = await uploaded(await upload(hub, web.cookie, sessionId, big))

    const parts: Array<{ data: string; next?: number }> = []
    for (let offset: number | undefined = 0; offset !== undefined;) {
      const response = await mod.request(`/mod/attachments/${id}?offset=${offset}`)
      expect(response.status).toBe(200)
      const part = (await response.json()) as { data: string; next?: number }
      // Under the 4 MiB the mod reads of a body, with room for the rest of the JSON.
      expect(part.data.length).toBeLessThan(4 * 1024 * 1024 - 1024)
      parts.push(part)
      offset = part.next
    }
    expect(parts.map((part) => part.next)).toEqual([2_400_000, 4_800_000, undefined])
    expect(Buffer.from(parts.map((part) => part.data).join(""), "base64")).toEqual(Buffer.from(big))
    expect((await mod.request(`/mod/attachments/${id}?offset=-1`)).status).toBe(400)
    // At its end, a part of nothing, the last; past it, none.
    const end = await mod.request(`/mod/attachments/${id}?offset=${MaxImageBytes}`)
    expect(await end.json()).toMatchObject({ data: "" })
    expect((await mod.request(`/mod/attachments/${id}?offset=${MaxImageBytes + 1}`)).status).toBe(
      400,
    )
  })

  test("of a 10 MB PDF joins from its five parts, each one the mod can read (#277)", async () => {
    const { hub, web, sessionId, mod } = await scene()
    const big = sized(pdf, MaxPdfBytes)
    const id = await uploaded(await upload(hub, web.cookie, sessionId, big, { name: "spec.pdf" }))

    const parts: Array<{ mediaType: string; data: string; next?: number }> = []
    for (let offset: number | undefined = 0; offset !== undefined;) {
      const response = await mod.request(`/mod/attachments/${id}?offset=${offset}`)
      const body = await response.text()
      expect(body.length).toBeLessThan(4 * 1024 * 1024)
      const part = JSON.parse(body) as { mediaType: string; data: string; next?: number }
      parts.push(part)
      offset = part.next
    }
    expect(parts).toHaveLength(5)
    expect(parts.every((part) => part.mediaType === "application/pdf")).toBe(true)
    expect(Buffer.from(parts.map((part) => part.data).join(""), "base64")).toEqual(Buffer.from(big))
  })
})

test("a Session's attachments are purged with it", async () => {
  const { hub, web, sessionId } = await scene()
  const id = await uploaded(await upload(hub, web.cookie, sessionId, png))
  const kept = () =>
    hub.run(
      Effect.gen(function* () {
        return yield* (yield* Attachments).get(sessionId as never, id as never)
      }),
    )
  expect((await kept())._tag).toBe("Some")
  await hub.run(
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const session = yield* sessions.get(sessionId as never)
      if (session._tag === "Some") yield* sessions.purge(session.value, Date.now())
    }),
  )
  expect((await kept())._tag).toBe("None")
})

// #280: the Attachments service alone, on a database in memory and a clock the test moves.

/** `effect` with the Attachments of a Hub that runs for as long as it does. */
const hubRunning = <A, E>(effect: Effect.Effect<A, E, Attachments>) =>
  Effect.provide(effect, Attachments.layer)

describe("an attachment nobody sent", () => {
  const sessionId = SessionId.make("s-1")
  const alice = ParticipantId.make("p-1")

  /** `effect` on a database with alice's Session, the clock at 0. */
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES (${alice}, 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`
          INSERT INTO sessions (id, repo, base_branch, work_branch, state, runner_id,
            runner_login_account, creator_id, created_at)
          VALUES (${sessionId}, 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com',
            ${alice}, 1)
        `
        return yield* effect
      }).pipe(Effect.provide(DatabaseTest), Effect.provide(TestClock.layer())),
    )

  const uploadAs = (name: string) =>
    Effect.flatMap(Attachments, (attachments) =>
      attachments.add({ sessionId, name, mediaType: "image/png", bytes: png, by: alice, at: 0 }),
    )

  const send = (id: AttachmentId) =>
    Effect.flatMap(Attachments, (attachments) => attachments.markSent(sessionId, [id], alice, 0))

  const kept = (id: AttachmentId) =>
    Effect.map(
      Effect.flatMap(Attachments, (attachments) => attachments.get(sessionId, id)),
      Option.isSome,
    )

  test("is deleted 24 hours after upload; one a prompt took is kept", async () => {
    const found = await run(
      hubRunning(
        Effect.gen(function* () {
          const dropped = yield* uploadAs("dropped.png")
          const sent = yield* uploadAs("sent.png")
          const taken = yield* send(sent.id)
          yield* TestClock.adjust(Duration.subtract(unsentAttachmentLifetime, Duration.minutes(1)))
          const before = { dropped: yield* kept(dropped.id), sent: yield* kept(sent.id) }
          // Swept hourly: gone within the hour after.
          yield* TestClock.adjust(Duration.hours(1))
          const after = { dropped: yield* kept(dropped.id), sent: yield* kept(sent.id) }
          return { taken: Option.isSome(taken), before, after }
        }),
      ),
    )
    expect(found).toEqual({
      taken: true,
      before: { dropped: true, sent: true },
      after: { dropped: false, sent: true },
    })
  })

  test("past 24 hours while the Hub was down, is deleted as it starts", async () => {
    const found = await run(
      Effect.gen(function* () {
        const { dropped, sent } = yield* hubRunning(
          Effect.gen(function* () {
            const files = {
              dropped: yield* uploadAs("dropped.png"),
              sent: yield* uploadAs("sent.png"),
            }
            yield* send(files.sent.id)
            return files
          }),
        )
        // Down for a day and a minute, so no sweep ran.
        yield* TestClock.setTime(Duration.toMillis(unsentAttachmentLifetime) + 60_000)
        return yield* hubRunning(Effect.all({ dropped: kept(dropped.id), sent: kept(sent.id) }))
      }),
    )
    expect(found).toEqual({ dropped: false, sent: true })
  })

  test("once deleted, can't be sent: its sender is asked to attach it again", async () => {
    const found = await run(
      hubRunning(
        Effect.gen(function* () {
          const late = yield* uploadAs("late.png")
          yield* TestClock.adjust(Duration.sum(unsentAttachmentLifetime, Duration.hours(1)))
          return yield* send(late.id)
        }),
      ),
    )
    expect(Option.isNone(found)).toBe(true)
  })

  test("named with a file that isn't the sender's, is refused, and isn't kept for it", async () => {
    const found = await run(
      hubRunning(
        Effect.gen(function* () {
          const attachments = yield* Attachments
          const mine = yield* uploadAs("mine.png")
          const marked = yield* attachments.markSent(
            sessionId,
            [mine.id, AttachmentId.make("made-up")],
            alice,
            0,
          )
          yield* TestClock.adjust(Duration.sum(unsentAttachmentLifetime, Duration.hours(1)))
          return { marked: Option.isSome(marked), kept: yield* kept(mine.id) }
        }),
      ),
    )
    expect(found).toEqual({ marked: false, kept: false })
  })
})
