import { afterEach, describe, expect, test } from "bun:test"
import {
  type CommandFailed,
  ProtocolVersion,
  RunnerId,
  SessionId,
  type TerminalFrame,
} from "@claude-hub/protocol"
import { HubClient } from "../src/hub/client.ts"
import { FakeHub } from "../src/hub/fake/FakeHub.ts"
import { demoSessionId } from "../src/hub/fake/script.ts"
import type { HubTransport, SocketHandlers } from "../src/hub/transport.ts"
import { alice } from "./fixtures.ts"

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
    const joined = () => client.getState().joined[demo]
    expect(joined()?.log[0]?.event._tag).toBe("TurnStarted")
    // Who's here comes as its own message, which can land after the history.
    await eventually(() =>
      expect(joined()?.presence.map((person) => person.login)).toEqual(["alice"]),
    )
    expect(joined()?.queue).toEqual([])
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

describe("the terminal", () => {
  type Frame = TerminalFrame
  const kinds = (frames: ReadonlyArray<Frame>) => frames.map((frame) => frame.kind)

  test("opening it draws a Snapshot, and typing comes back as Output", async () => {
    const { hub, client } = setUp({ autoplay: false })
    const frames: Array<Frame> = []
    client.start()
    client.openTerminal(demo, (frame) => frames.push(frame))
    await eventually(() => expect(kinds(frames)).toEqual(["Snapshot"]))
    expect(frames[0]?.size).toEqual({ cols: 120, rows: 40 })
    expect(frames[0]?.data).toContain("Do you want to proceed?")
    expect(client.getState().terminals[demo]).toEqual({
      status: "live",
      size: { cols: 120, rows: 40 },
    })
    // Esc dismisses Claude Code's dialog.
    expect(client.sendTerminalInput(demo, "\x1b")).toBe(true)
    await eventually(() => expect(frames.at(-1)?.data).toContain("User rejected the command"))
    expect(frames.at(-1)?.kind).toBe("Output")
    expect(hub.received.filter((message) => message._tag.includes("Terminal"))).toEqual([
      { _tag: "OpenTerminal", sessionId: demo },
      { _tag: "TerminalInput", sessionId: demo, data: "\x1b" },
    ])
  })

  test("a resize redraws everyone watching from a Snapshot at the new size", async () => {
    const { hub, client } = setUp({ autoplay: false })
    const other = new HubClient(hub, { retryDelay: () => 1 })
    cleanups.push(() => other.stop())
    const mine: Array<Frame> = []
    const theirs: Array<Frame> = []
    client.start()
    other.start()
    client.openTerminal(demo, (frame) => mine.push(frame))
    other.openTerminal(demo, (frame) => theirs.push(frame))
    await eventually(() => expect(kinds(theirs)).toEqual(["Snapshot"]))
    await eventually(() => expect(kinds(mine)).toEqual(["Snapshot"]))
    client.resizeTerminal(demo, { cols: 90, rows: 30 })
    await eventually(() => expect(theirs.at(-1)?.size).toEqual({ cols: 90, rows: 30 }))
    expect(theirs.at(-1)?.kind).toBe("Snapshot")
    await eventually(() => expect(mine.at(-1)?.size).toEqual({ cols: 90, rows: 30 }))
    expect(other.getState().terminals[demo]?.size).toEqual({ cols: 90, rows: 30 })
  })

  test("after a dropped connection it opens the terminal again and redraws from a new Snapshot", async () => {
    const { hub, client } = setUp({ autoplay: false })
    const frames: Array<Frame> = []
    client.start()
    client.openTerminal(demo, (frame) => frames.push(frame))
    await eventually(() => expect(kinds(frames)).toEqual(["Snapshot"]))
    hub.dropConnections()
    await eventually(() => expect(client.getState().terminals[demo]?.status).toBe("waiting"))
    await eventually(() => expect(kinds(frames)).toEqual(["Snapshot", "Snapshot"]))
    expect(hub.received.filter((message) => message._tag === "OpenTerminal")).toHaveLength(2)
    expect(client.getState().terminals[demo]?.status).toBe("live")
    client.sendTerminalInput(demo, "1")
    await eventually(() => expect(kinds(frames)).toContain("Output"))
  })

  test("Output that doesn't follow a Snapshot is never drawn", async () => {
    const sent: Array<unknown> = []
    let toClient: ((message: object) => void) | undefined
    const transport: HubTransport = {
      open(handlers) {
        toClient = (message) => handlers.onMessage(JSON.stringify(message))
        setTimeout(() => handlers.onOpen(), 0)
        return {
          send: (text) => {
            const message = JSON.parse(text) as { _tag: string }
            sent.push(message)
            if (message._tag === "WebHello") {
              toClient?.({ _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice })
            }
          },
          close: () => setTimeout(() => handlers.onClose(), 0),
        }
      },
      signInStatus: async () => ({ signedIn: true }),
      devSignIn: async () => {},
      signOut: async () => {},
    }
    const client = new HubClient(transport, { retryDelay: () => 1 })
    cleanups.push(() => client.stop())
    const frames: Array<Frame> = []
    client.start()
    const close = client.openTerminal(demo, (frame) => frames.push(frame))
    await eventually(() => expect(sent.at(-1)).toEqual({ _tag: "OpenTerminal", sessionId: demo }))
    const frame = (kind: string, data: string) => ({
      _tag: "TerminalFrame",
      sessionId: demo,
      kind,
      data,
      size: { cols: 80, rows: 24 },
    })
    toClient?.(frame("Output", "before"))
    toClient?.(frame("Snapshot", "screen"))
    toClient?.(frame("Output", "after"))
    toClient?.({ ...frame("Snapshot", "elsewhere"), sessionId: "s-other" })
    expect(frames.map((f) => f.data)).toEqual(["screen", "after"])
    close()
    expect(sent.at(-1)).toEqual({ _tag: "CloseTerminal", sessionId: demo })
    toClient?.(frame("Snapshot", "closed"))
    expect(frames.map((f) => f.data)).toEqual(["screen", "after"])
    expect(client.getState().terminals).toEqual({})
  })

  test("two views of one terminal both draw it; it stays open until both close", async () => {
    const { hub, client } = setUp({ autoplay: false })
    const first: Array<Frame> = []
    const second: Array<Frame> = []
    client.start()
    const closeFirst = client.openTerminal(demo, (frame) => first.push(frame))
    await eventually(() => expect(kinds(first)).toEqual(["Snapshot"]))
    const closeSecond = client.openTerminal(demo, (frame) => second.push(frame))
    await eventually(() => expect(kinds(second)).toEqual(["Snapshot"]))
    closeFirst()
    expect(hub.received.some((message) => message._tag === "CloseTerminal")).toBe(false)
    client.sendTerminalInput(demo, "\x1b[B")
    await eventually(() => expect(kinds(second)).toContain("Output"))
    expect(kinds(first)).not.toContain("Output")
    closeSecond()
    await eventually(() =>
      expect(hub.received.at(-1)).toEqual({ _tag: "CloseTerminal", sessionId: demo }),
    )
  })

  test("an Asleep Session's terminal waits, refuses keystrokes, and draws once woken", async () => {
    const { client } = setUp({ autoplay: false })
    const readme = SessionId.make("s-readme")
    const failures: Array<CommandFailed> = []
    const frames: Array<Frame> = []
    client.onCommandFailed((failure) => failures.push(failure))
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    client.openTerminal(readme, (frame) => frames.push(frame))
    client.sendTerminalInput(readme, "x")
    await eventually(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({ command: "TerminalInput", sessionId: readme })
    expect(frames).toEqual([])
    expect(client.getState().terminals[readme]?.status).toBe("waiting")
    client.wakeSession(readme)
    await eventually(() => expect(kinds(frames)).toEqual(["Snapshot"]))
    expect(frames[0]?.data).toContain("Welcome to")
  })

  test("keystrokes and resizes while offline aren't sent", () => {
    const { client } = setUp()
    expect(client.sendTerminalInput(demo, "x")).toBe(false)
    expect(client.sendTerminalInput(demo, "")).toBe(false)
    expect(client.resizeTerminal(demo, { cols: 80, rows: 24 })).toBe(false)
  })
})

const find = (client: InstanceType<typeof HubClient>, id: string) =>
  client.getState().sessions?.find((session) => session.id === id)

describe("archiving", () => {
  const readme = SessionId.make("s-readme")

  test("deleting archives a Session at once, saying who; restoring brings it back Asleep", async () => {
    const { client } = setUp()
    client.start()
    client.join(readme)
    await eventually(() => expect(client.getState().joined[readme]?.historyLoaded).toBe(true))

    expect(client.archiveSession(readme)).toBe(true)
    await eventually(() => expect(find(client, readme)?.state).toBe("Archived"))
    const archived = find(client, readme)?.archived
    expect(archived?.by.login).toBe("alice")
    expect(archived && archived.purgeAt - archived.at).toBe(30 * 24 * 3_600_000)
    const log = () => client.getState().joined[readme]?.log.map((entry) => entry.event) ?? []
    expect(log().at(-1)).toMatchObject({ _tag: "SessionStateChanged", state: "Archived" })

    expect(client.restoreSession(readme)).toBe(true)
    await eventually(() => expect(find(client, readme)?.state).toBe("Asleep"))
    expect(find(client, readme)?.archived).toBeUndefined()
    expect(log().at(-1)).toMatchObject({
      _tag: "SessionStateChanged",
      state: "Asleep",
      by: { login: "alice" },
    })
  })

  test("an Archived Session refuses prompts with a clear reason", async () => {
    const { client } = setUp()
    const failures: Array<CommandFailed> = []
    client.onCommandFailed((failure) => failures.push(failure))
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    client.sendPrompt(SessionId.make("s-flaky"), "hello")
    await eventually(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({ command: "SendPrompt", sessionId: "s-flaky" })
    expect(failures[0]?.message).toContain("archived")
  })

  test("restoring a Session that isn't archived is refused", async () => {
    const { client } = setUp()
    const failures: Array<CommandFailed> = []
    client.onCommandFailed((failure) => failures.push(failure))
    client.start()
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    client.restoreSession(readme)
    await eventually(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({ command: "RestoreSession", sessionId: "s-readme" })
  })
})
