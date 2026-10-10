// Attachments (#276, ADR 0024): a Participant uploads a file to a Session over HTTP, sends a
// prompt naming it, and the Session's mod fetches it for Claude. A real Hub, a fake Runner and
// web clients over WebSockets, and a fake mod over HTTP.

import { afterEach, describe, expect, test } from "bun:test"
import {
  type ModCommandsEncoded,
  type ModEventsEncoded,
  MaxImageBytes,
  ProtocolVersion,
} from "@kndl/protocol"
import { Effect } from "effect"
import { Attachments } from "./Attachments.ts"
import { Sessions } from "./Sessions.ts"
import { issueRunnerToken, openRunner, openWeb, stopAll } from "./testChannels.ts"
import { bearer, seedEnvironment, startHub, type TestHub, webOrigin } from "./testSupport.ts"

afterEach(stopAll)

type Command = ModCommandsEncoded["messages"][number]["message"]
type ModEvent = ModEventsEncoded["messages"][number]

/** A PNG's signature and a little more: what the Hub tells a PNG by. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7])

/** A Session alice created, started, with its mod linked; and a way to upload to it. */
async function scene() {
  const hub = await startHub({ config: { devLogin: true } })
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
    const big = new Uint8Array(MaxImageBytes)
    big.set(png)
    big.fill(7, png.byteLength)
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
