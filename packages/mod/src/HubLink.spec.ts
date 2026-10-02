import { describe, expect, test } from "bun:test"
import { ProtocolVersion } from "@claude-hub/protocol"
import type { ModCommand } from "@claude-hub/protocol"
import { HubLink, retryDelay } from "./HubLink.ts"
import type { HubFetch, LinkStatus } from "./HubLink.ts"

type Request = { readonly method: string; readonly path: string; readonly body?: string }
type Reply = { readonly status: number; readonly text: string }

const welcome: Reply = {
  status: 200,
  text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: ProtocolVersion }),
}
const commands = (...messages: Array<{ seq: number; message: unknown }>): Reply => ({
  status: 200,
  text: JSON.stringify({ messages }),
})
const stop = { _tag: "StopTurn", sessionId: "s1" }

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * A link over a scripted Hub: `answer` replies to each request, or holds it (undefined) as a long
 * poll would. `sleep` resolves at once and is recorded.
 */
const harness = (answer: (request: Request, index: number) => Reply | Error | undefined) => {
  const requests: Array<Request> = []
  const sleeps: Array<number> = []
  const statuses: Array<LinkStatus["_tag"]> = []
  const handled: Array<ModCommand["_tag"]> = []
  const fetch: HubFetch = (url, init) => {
    const request = {
      method: init.method,
      path: url.replace("http://hub.test", ""),
      ...(init.body === undefined ? {} : { body: init.body }),
    }
    requests.push(request)
    const reply = answer(request, requests.length - 1)
    if (reply === undefined) return new Promise(() => undefined)
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
  }
  const link = new HubLink({
    hubUrl: "http://hub.test/",
    modToken: "secret",
    hello: { sessionId: "s1", claudeSessionId: "c1", model: "claude-test" },
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    onCommand: async (command) => {
      handled.push(command._tag)
    },
    onStatus: (status) => statuses.push(status._tag),
    log: () => undefined,
    flushDelayMs: 0,
  })
  return { link, requests, sleeps, statuses, handled }
}

const paths = (requests: ReadonlyArray<Request>) => requests.map((r) => `${r.method} ${r.path}`)

describe("HubLink", () => {
  test("says hello, then polls from where it left off", async () => {
    const { link, requests, handled } = harness((request, index) => {
      if (request.path === "/mod/hello") return welcome
      if (index === 1) return commands({ seq: 1, message: stop }, { seq: 2, message: stop })
      return undefined
    })
    link.start()
    await settle()
    link.stop()
    expect(paths(requests)).toEqual([
      "POST /mod/hello",
      "GET /mod/commands?after=0&waitMs=25000",
      "GET /mod/commands?after=2&waitMs=25000",
    ])
    expect(handled).toEqual(["StopTurn", "StopTurn"])
  })

  test("on 409 says hello again and polls from after=0", async () => {
    const { link, requests, handled } = harness((request, index) => {
      if (request.path === "/mod/hello") return welcome
      if (index === 1) return commands({ seq: 5, message: stop })
      if (index === 2) return { status: 409, text: "" }
      if (index === 4) return commands({ seq: 1, message: stop })
      return undefined
    })
    link.start()
    await settle()
    link.stop()
    expect(paths(requests)).toEqual([
      "POST /mod/hello",
      "GET /mod/commands?after=0&waitMs=25000",
      "GET /mod/commands?after=5&waitMs=25000",
      "POST /mod/hello",
      "GET /mod/commands?after=0&waitMs=25000",
      "GET /mod/commands?after=1&waitMs=25000",
    ])
    expect(handled).toEqual(["StopTurn", "StopTurn"])
  })

  test("backs off while the Hub is unreachable, then links", async () => {
    let failures = 4
    const { link, sleeps, statuses } = harness((request) => {
      if (request.path === "/mod/hello") return failures-- > 0 ? new Error("ECONNREFUSED") : welcome
      return undefined
    })
    link.start()
    await settle()
    link.stop()
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(statuses.at(-1)).toBe("Linked")
    expect(statuses).toContain("Offline")
  })

  test("backs off when polling fails", async () => {
    const { link, sleeps } = harness((request, index) => {
      if (request.path === "/mod/hello") return welcome
      if (index < 4) return { status: 502, text: "bad gateway" }
      return undefined
    })
    link.start()
    await settle()
    link.stop()
    expect(sleeps).toEqual([1_000, 2_000, 4_000])
  })

  test("stops when the Hub refuses the token", async () => {
    const { link, requests, statuses } = harness(() => ({ status: 401, text: "" }))
    link.start()
    await settle()
    expect(paths(requests)).toEqual(["POST /mod/hello"])
    expect(statuses.at(-1)).toBe("Rejected")
    link.report({ _tag: "TextDelta", turnId: "t1", text: "x" })
    await settle()
    expect(requests).toHaveLength(1)
  })

  test("posts events in a batch, after saying hello", async () => {
    const { link, requests } = harness((request) => {
      if (request.path === "/mod/hello") return welcome
      if (request.path === "/mod/events") return { status: 204, text: "" }
      return undefined
    })
    link.report({ _tag: "TurnStarted", turnId: "t1", text: "hi", sender: { _tag: "FromTerminal" } })
    link.report({ _tag: "TextDelta", turnId: "t1", text: "Hel" })
    link.report({ _tag: "TextDelta", turnId: "t1", text: "lo" })
    link.report({ _tag: "NotAnEvent" })
    await settle()
    link.stop()
    const posts = requests.filter((r) => r.path === "/mod/events")
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      messages: [
        { _tag: "TurnStarted", turnId: "t1", text: "hi", sender: { _tag: "FromTerminal" } },
        { _tag: "TextDelta", turnId: "t1", text: "Hello" },
      ],
    })
  })

  test("on 409 for events says hello again and posts the batch again", async () => {
    let eventPosts = 0
    const { link, requests } = harness((request) => {
      if (request.path === "/mod/hello") return welcome
      if (request.path === "/mod/events")
        return { status: eventPosts++ === 0 ? 409 : 204, text: "" }
      return undefined
    })
    link.report({ _tag: "TextDelta", turnId: "t1", text: "x" })
    await settle()
    link.stop()
    expect(paths(requests.filter((r) => r.method === "POST"))).toEqual([
      "POST /mod/hello",
      "POST /mod/events",
      "POST /mod/hello",
      "POST /mod/events",
    ])
    const bodies = requests.filter((r) => r.path === "/mod/events").map((r) => r.body)
    expect(bodies[0]).toBe(bodies[1])
  })

  test("retries a failed post with backoff, keeping the order", async () => {
    let eventPosts = 0
    const { link, requests, sleeps } = harness((request) => {
      if (request.path === "/mod/hello") return welcome
      if (request.path === "/mod/events")
        return eventPosts++ < 2 ? new Error("ECONNRESET") : { status: 204, text: "" }
      return undefined
    })
    link.report({ _tag: "TextDelta", turnId: "t1", text: "a" })
    await settle()
    link.stop()
    const bodies = requests.filter((r) => r.path === "/mod/events").map((r) => r.body)
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies).size).toBe(1)
    expect(sleeps).toContain(1_000)
    expect(sleeps).toContain(2_000)
  })
})

test("retryDelay doubles from 1 s up to 30 s", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 20].map(retryDelay)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
  ])
})
