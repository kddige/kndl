import { afterEach, describe, expect, test } from "bun:test"
import { type CommandFailed, ProtocolVersion, RunnerId, SessionId } from "@claude-hub/protocol"
import { HubClient } from "../src/hub/client.ts"
import { FakeHub } from "../src/hub/fake/FakeHub.ts"
import { demoSessionId } from "../src/hub/fake/script.ts"
import type { HubTransport, SocketHandlers } from "../src/hub/transport.ts"

const demo = SessionId.make(demoSessionId)
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setUp(options: ConstructorParameters<typeof FakeHub>[0] = {}) {
  const hub = new FakeHub({ stepMs: 1, ...options })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  cleanups.push(() => {
    client.stop()
    hub.dispose()
  })
  return { hub, client }
}

/** Waits until `check` stops throwing, or fails with its last error. */
async function eventually(check: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await Bun.sleep(2)
    }
  }
}

describe("connecting", () => {
  test("says hello, and is online with the Runners and Sessions after the welcome", async () => {
    const { hub, client } = setUp()
    client.start()
    expect(client.getState().connection).toEqual({ status: "connecting", attempt: 0 })
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    expect(hub.received[0]).toEqual({ _tag: "WebHello", protocolVersion: ProtocolVersion })
    const state = client.getState()
    expect(state.you?.login).toBe("alice")
    expect(state.runners?.map((runner) => runner.name)).toEqual(["studio", "ci-box"])
    expect(state.sessions?.map((session) => session.id)).toContain(demo)
  })

  test("signed out: shows the sign-in options the Hub offers, then connects after dev login", async () => {
    const { hub, client } = setUp({ signedIn: false, signInOptions: { github: false, dev: true } })
    client.start()
    await eventually(() =>
      expect(client.getState().connection).toEqual({
        status: "signedOut",
        options: { github: false, dev: true },
      }),
    )
    await hub.devSignIn("carol")
    client.retry()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    expect(client.getState().you?.login).toBe("carol")
  })

  test("a HandshakeRejected leaves it rejected with the Hub's message, without retrying", async () => {
    let opened = 0
    const transport: HubTransport = {
      open(handlers: SocketHandlers) {
        opened++
        setTimeout(() => handlers.onOpen(), 0)
        return {
          send: () =>
            setTimeout(() =>
              handlers.onMessage(
                JSON.stringify({
                  _tag: "HandshakeRejected",
                  reason: "ProtocolVersionMismatch",
                  protocolVersion: 2,
                  message: "Update the web UI.",
                }),
              ),
            ),
          close: () => setTimeout(() => handlers.onClose(), 0),
        }
      },
      signInStatus: async () => ({ signedIn: true }),
      devSignIn: async () => {},
      signOut: async () => {},
    }
    const client = new HubClient(transport, { retryDelay: () => 1 })
    cleanups.push(() => client.stop())
    client.start()
    await eventually(() =>
      expect(client.getState().connection).toEqual({
        status: "rejected",
        message: "Update the web UI.",
      }),
    )
    await Bun.sleep(20)
    expect(opened).toBe(1)
  })

  test("a welcome from a Hub of another version is rejected before decoding", async () => {
    const transport: HubTransport = {
      open(handlers) {
        setTimeout(() => handlers.onOpen(), 0)
        return {
          send: () =>
            setTimeout(() =>
              handlers.onMessage(
                JSON.stringify({ _tag: "WebWelcome", protocolVersion: ProtocolVersion + 1 }),
              ),
            ),
          close: () => setTimeout(() => handlers.onClose(), 0),
        }
      },
      signInStatus: async () => ({ signedIn: true }),
      devSignIn: async () => {},
      signOut: async () => {},
    }
    const client = new HubClient(transport)
    cleanups.push(() => client.stop())
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("rejected"))
  })

  test("an unreachable Hub is retried", async () => {
    let opened = 0
    const transport: HubTransport = {
      open(handlers) {
        opened++
        setTimeout(() => handlers.onClose(), 0)
        return { send: () => {}, close: () => {} }
      },
      signInStatus: async () => {
        throw new Error("fetch failed")
      },
      devSignIn: async () => {},
      signOut: async () => {},
    }
    const client = new HubClient(transport, { retryDelay: () => 1 })
    cleanups.push(() => client.stop())
    client.start()
    await eventually(() => expect(opened).toBeGreaterThanOrEqual(3))
    expect(client.getState().connection.status).toBe("reconnecting")
  })
})

describe("a joined Session", () => {
  test("joining loads the history, the Prompt queue and who's here", async () => {
    const { client } = setUp({ autoplay: false })
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    const joined = client.getState().joined[demo]
    expect(joined?.log[0]?.event._tag).toBe("TurnStarted")
    expect(joined?.presence.map((person) => person.login)).toEqual(["alice"])
    expect(joined?.queue).toEqual([])
  })

  test("joining before the welcome sends the join once welcomed", async () => {
    const { hub, client } = setUp({ autoplay: false })
    client.start()
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    expect(hub.received.filter((message) => message._tag === "JoinSession")).toHaveLength(1)
  })

  test("a prompt runs a Turn that streams in, and the Session is idle again after", async () => {
    const { client } = setUp({ autoplay: false })
    client.start()
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    expect(client.sendPrompt(demo, "  Rename the store  ")).toBe(true)
    await eventually(() => {
      const log = client.getState().joined[demo]?.log ?? []
      const started = log.findLast((entry) => entry.event._tag === "TurnStarted")
      expect(started?.event).toMatchObject({ text: "[Alice Kim] Rename the store" })
      expect(log.at(-1)?.event._tag).toBe("TurnEnded")
    })
    const session = client.getState().sessions?.find((candidate) => candidate.id === demo)
    expect(session?.currentTurn).toBeNull()
  })

  test("a prompt sent while a Turn runs waits in the queue, and can be cancelled", async () => {
    const { hub, client } = setUp({ autoplay: false, stepMs: 5 })
    client.start()
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    client.sendPrompt(demo, "First")
    client.sendPrompt(demo, "Second")
    await eventually(() =>
      expect(client.getState().joined[demo]?.queue.map((prompt) => prompt.text)).toEqual([
        "Second",
      ]),
    )
    const queued = client.getState().joined[demo]?.queue[0]
    if (!queued) throw new Error("expected a queued prompt")
    client.cancelPrompt(demo, queued.id)
    await eventually(() => expect(client.getState().joined[demo]?.queue).toEqual([]))
    expect(hub.received.at(-1)).toEqual({
      _tag: "CancelPrompt",
      sessionId: demo,
      promptId: queued.id,
    })
  })

  test("Stop ends the running Turn as Stopped, after recording who asked", async () => {
    const { client } = setUp({ autoplay: false, stepMs: 5 })
    client.start()
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    client.sendPrompt(demo, "Something long")
    await eventually(() => {
      const session = client.getState().sessions?.find((candidate) => candidate.id === demo)
      expect(session?.currentTurn).not.toBeNull()
    })
    client.stopTurn(demo)
    await eventually(() => {
      const events = (client.getState().joined[demo]?.log ?? []).map((entry) => entry.event)
      expect(events.some((event) => event._tag === "TurnStopRequested")).toBe(true)
      expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", reason: "Stopped" })
    })
  })

  test("after a dropped connection it rejoins with afterSeq and holds each entry once", async () => {
    const { hub, client } = setUp({ autoplay: false })
    client.start()
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    const before = client.getState().joined[demo]?.log.length ?? 0
    hub.dropConnections()
    await eventually(() => expect(client.getState().connection.status).toBe("reconnecting"))
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    await eventually(() => {
      const joins = hub.received.filter((message) => message._tag === "JoinSession")
      expect<unknown>(joins.at(-1)).toEqual({
        _tag: "JoinSession",
        sessionId: demo,
        afterSeq: before - 1,
      })
    })
    client.sendPrompt(demo, "After the drop")
    await eventually(() =>
      expect(client.getState().joined[demo]?.log.at(-1)?.event._tag).toBe("TurnEnded"),
    )
    const seqs = (client.getState().joined[demo]?.log ?? []).map((entry) => entry.seq)
    expect<unknown>(seqs).toEqual(seqs.map((_, index) => index))
  })

  test("leaving stops the Session's updates", async () => {
    const { hub, client } = setUp({ autoplay: false })
    client.start()
    client.join(demo)
    await eventually(() => expect(client.getState().joined[demo]?.historyLoaded).toBe(true))
    client.leave(demo)
    expect(client.getState().joined[demo]).toBeUndefined()
    await eventually(() =>
      expect(hub.received.at(-1)).toEqual({ _tag: "LeaveSession", sessionId: demo }),
    )
  })

  test("the demo script brings Bob in and he queues a prompt", async () => {
    const { client } = setUp({ stepMs: 2 })
    client.start()
    client.join(demo)
    await eventually(() =>
      expect(client.getState().joined[demo]?.presence.map((person) => person.login)).toEqual([
        "alice",
        "bob",
      ]),
    )
    await eventually(() =>
      expect(client.getState().joined[demo]?.queue[0]?.sender.login).toBe("bob"),
    )
  })
})

describe("commands", () => {
  test("createSession resolves with the new Session, which is listed", async () => {
    const { client } = setUp()
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    const session = await client.createSession({
      repo: "kddige/claude-hub",
      baseBranch: "main",
      runnerId: RunnerId.make("r-studio"),
    })
    expect(session).toMatchObject({
      repo: "kddige/claude-hub",
      baseBranch: "main",
      state: "Active",
    })
    expect(client.getState().sessions?.some((listed) => listed.id === session.id)).toBe(true)
  })

  test("createSession rejects with the Hub's reason", async () => {
    const { client } = setUp()
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    await expect(
      client.createSession({
        repo: "kddige/claude-hub",
        baseBranch: "main",
        runnerId: RunnerId.make("r-ci"),
      }),
    ).rejects.toThrow("ci-box is offline.")
  })

  test("commands while offline aren't sent", async () => {
    const { client } = setUp()
    expect(client.sendPrompt(demo, "hello")).toBe(false)
    expect(client.stopTurn(demo)).toBe(false)
    await expect(client.createSession({ repo: "a/b", baseBranch: "main" })).rejects.toThrow(
      "Not connected",
    )
  })

  test("a refused command is reported to onCommandFailed", async () => {
    const { client } = setUp()
    const failures: Array<CommandFailed> = []
    client.onCommandFailed((failure) => failures.push(failure))
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    // A Frozen Session can't be put to sleep: its Runner is offline.
    client.sleepSession(SessionId.make("s-dotfiles"))
    await eventually(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({ command: "SleepSession", sessionId: "s-dotfiles" })
  })

  test("a prompt to a Frozen Session waits in its queue", async () => {
    const { client } = setUp()
    const dotfiles = SessionId.make("s-dotfiles")
    const failures: Array<CommandFailed> = []
    client.onCommandFailed((failure) => failures.push(failure))
    client.start()
    client.join(dotfiles)
    await eventually(() => expect(client.getState().joined[dotfiles]?.historyLoaded).toBe(true))
    client.sendPrompt(dotfiles, "hello")
    await eventually(() =>
      expect(client.getState().joined[dotfiles]?.queue.map((prompt) => prompt.text)).toEqual([
        "hello",
      ]),
    )
    expect(failures).toEqual([])
  })

  test("a prompt to an Asleep Session wakes it", async () => {
    const { client } = setUp()
    const readme = SessionId.make("s-readme")
    client.start()
    client.join(readme)
    await eventually(() => expect(client.getState().joined[readme]?.historyLoaded).toBe(true))
    client.sendPrompt(readme, "Wake up")
    await eventually(() => {
      const session = client.getState().sessions?.find((candidate) => candidate.id === readme)
      expect(session?.state).toBe("Active")
    })
    const events = client.getState().joined[readme]?.log.map((entry) => entry.event) ?? []
    expect(events.findLast((event) => event._tag === "SessionStateChanged")).toMatchObject({
      state: "Active",
    })
  })
})
