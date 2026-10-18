import { describe, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { ProtocolVersion } from "@kndl/protocol"
import type { ModCommand } from "@kndl/protocol"
import { HubLink, LostTimerMs, retryDelay } from "./HubLink.ts"
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

/** A Hub that welcomes the mod, takes its events and holds its polls. */
const hub = (request: Request): Reply | undefined => {
  if (request.path === "/mod/hello") return welcome
  if (request.path === "/mod/events") return { status: 204, text: "" }
  return undefined
}
const delta = (text: string) => ({ _tag: "TextDelta", turnId: "t1", text })
/** The text of each batch posted. */
const posted = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((r) => r.path === "/mod/events")
    .map((r) =>
      (JSON.parse(r.body ?? "").messages as Array<{ text: string }>).map((m) => m.text).join(""),
    )

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Which hook's dispatch the code running now belongs to, as Claude Code tracks it: a `$` call made
 * in the dispatch of a Turn a Stop aborted is refused (#165), and a timer's callback runs in none.
 */
const dispatch = new AsyncLocalStorage<"Aborted">()
/** Runs `fn` as a hook of a Turn a Stop aborted. */
const inAbortedHook = (fn: () => void) => dispatch.run("Aborted", fn)
const turnAbort = () => new Error("HooksError: turn-abort")

/**
 * A link over a scripted Hub: `answer` replies to each request, or holds it (undefined) as a long
 * poll would. Each timer fires at once, and its wait is recorded. `timers` loses a timer (it never
 * fires) or refuses one (setting it throws), by its index; `now` is the time the link reads.
 */
const harness = (
  answer: (request: Request, index: number) => Reply | Error | undefined,
  options: {
    readonly runsCommands?: boolean
    readonly timers?: Record<number, "Lost" | "Refused">
    readonly now?: () => number
  } = {},
) => {
  const requests: Array<Request> = []
  const waits: Array<number> = []
  const statuses: Array<LinkStatus["_tag"]> = []
  const handled: Array<ModCommand["_tag"]> = []
  let fetches = 0
  const fetch: HubFetch = (url, init) => {
    // Timers fire at once here, so a link retrying without end would spin: hold it instead.
    if (++fetches > 100) return new Promise(() => undefined)
    if (dispatch.getStore() === "Aborted") return Promise.reject(turnAbort())
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
    hello: {
      sessionId: "s1",
      conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-test",
    },
    fetch,
    after: (ms, fn) => {
      const fate = options.timers?.[waits.length]
      waits.push(ms)
      if (fate === "Refused") throw turnAbort()
      if (fate !== "Lost") queueMicrotask(() => dispatch.exit(fn))
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.runsCommands === false
      ? {}
      : {
          onCommand: async (command: ModCommand) => {
            handled.push(command._tag)
          },
        }),
    onStatus: (status) => statuses.push(status._tag),
    log: () => undefined,
    flushDelayMs: 0,
  })
  return { link, requests, waits, statuses, handled }
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

  test("knows a Hub takes PromptAlreadySubmitted only once its welcome says so (#323)", async () => {
    const takes = { _tag: "ModWelcome", protocolVersion: ProtocolVersion, alreadySubmitted: true }
    for (const [reply, expected] of [
      [welcome, false],
      [{ status: 200, text: JSON.stringify(takes) }, true],
    ] as const) {
      const { link } = harness((request) => (request.path === "/mod/hello" ? reply : undefined))
      expect(link.takesAlreadySubmitted).toBe(false)
      link.start()
      await settle()
      link.stop()
      expect(link.takesAlreadySubmitted).toBe(expected)
    }
  })

  test("without onCommand only says hello, and never polls", async () => {
    const { link, requests, statuses } = harness(() => welcome, { runsCommands: false })
    link.start()
    await settle()
    link.report({ _tag: "TextDelta", turnId: "t1", text: "hi" })
    await settle()
    link.stop()
    expect(paths(requests)).toEqual(["POST /mod/hello", "POST /mod/events"])
    expect(statuses).toEqual(["Linking", "Linked"])
  })

  test("reads a hello given as a function each time it says hello, as a pi Session's model changes", async () => {
    let model = "openai/gpt-a"
    const requests: Array<Request> = []
    const link = new HubLink({
      hubUrl: "http://hub.test",
      modToken: "secret",
      hello: () => ({
        sessionId: "s1",
        conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
        model,
        switchesModels: true,
      }),
      fetch: async (url, init) => {
        const request = {
          method: init.method,
          path: new URL(url).pathname,
          ...(init.body === undefined ? {} : { body: init.body }),
        }
        requests.push(request)
        if (request.path === "/mod/hello") return welcome
        // The model switches, then the Hub restarts and forgets the mod.
        if (requests.length === 2) {
          model = "xai/grok-b"
          return { status: 409, text: "" }
        }
        return new Promise(() => undefined)
      },
      after: (_ms, fn) => queueMicrotask(fn),
      onCommand: async () => undefined,
      onStatus: () => undefined,
      log: () => undefined,
    })
    link.start()
    await settle()
    link.stop()
    const said = requests
      .filter((r) => r.path === "/mod/hello")
      .map((r) => JSON.parse(r.body ?? "") as { model: string; switchesModels?: true })
    expect(said.map((hello) => hello.model)).toEqual(["openai/gpt-a", "xai/grok-b"])
    expect(said.every((hello) => hello.switchesModels === true)).toBe(true)
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
    const { link, waits, statuses } = harness((request) => {
      if (request.path === "/mod/hello") return failures-- > 0 ? new Error("ECONNREFUSED") : welcome
      return undefined
    })
    link.start()
    await settle()
    link.stop()
    expect(waits.filter((ms) => ms > 0)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(statuses.at(-1)).toBe("Linked")
    expect(statuses).toContain("Offline")
  })

  test("backs off when polling fails", async () => {
    const { link, waits } = harness((request, index) => {
      if (request.path === "/mod/hello") return welcome
      if (index < 4) return { status: 502, text: "bad gateway" }
      return undefined
    })
    link.start()
    await settle()
    link.stop()
    expect(waits.filter((ms) => ms > 0)).toEqual([1_000, 2_000, 4_000])
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
    const { link, requests, waits } = harness((request) => {
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
    expect(waits).toContain(1_000)
    expect(waits).toContain(2_000)
  })

  describe("after a Stop (#165)", () => {
    test("posts what a Stopped Turn's hooks report, and all after it", async () => {
      const { link, requests } = harness(hub, { runsCommands: false })
      link.start()
      await settle()
      inAbortedHook(() => link.report(delta("a")))
      await settle()
      link.report(delta("b"))
      await settle()
      link.stop()
      expect(posted(requests)).toEqual(["a", "b"])
    })

    test("a flush timer that never fires holds events back only until it is overdue", async () => {
      let now = 0
      const { link, requests } = harness(hub, {
        runsCommands: false,
        timers: { 1: "Lost" },
        now: () => now,
      })
      link.start()
      await settle()
      link.report(delta("a"))
      await settle()
      link.report(delta("b"))
      await settle()
      expect(posted(requests)).toEqual([])
      now += LostTimerMs + 1
      link.report(delta("c"))
      await settle()
      link.report(delta("d"))
      await settle()
      link.stop()
      expect(posted(requests)).toEqual(["abc", "d"])
    })

    test("a flush timer refused at once posts the events then, and later ones after", async () => {
      const { link, requests } = harness(hub, { runsCommands: false, timers: { 1: "Refused" } })
      link.start()
      await settle()
      link.report(delta("a"))
      await settle()
      link.report(delta("b"))
      await settle()
      link.stop()
      expect(posted(requests)).toEqual(["a", "b"])
    })

    test("polls on after running a Stop, and posts what follows", async () => {
      let polls = 0
      const { link, requests, handled } = harness((request) => {
        if (!request.path.startsWith("/mod/commands")) return hub(request)
        polls++
        if (polls === 1) return commands({ seq: 1, message: stop })
        if (polls === 2) return commands({ seq: 2, message: stop })
        return undefined
      })
      link.start()
      await settle()
      inAbortedHook(() => link.report(delta("a")))
      await settle()
      link.stop()
      expect(handled).toEqual(["StopTurn", "StopTurn"])
      expect(posted(requests)).toEqual(["a"])
    })
  })
})

test("retryDelay doubles from 1 s up to 30 s", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 20].map(retryDelay)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
  ])
})
