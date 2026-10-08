import { afterEach, describe, expect, test } from "bun:test"
import {
  type CommandFailed,
  DefaultEnvironmentDraft,
  type EnvironmentDraft,
  Participant,
  ProtocolVersion,
  RunnerId,
  SessionId,
  type TerminalFrame,
} from "@kndl/protocol"
import { Redacted, Schema } from "effect"
import { editFrom, toDraft } from "../src/environment/draft.ts"
import { HubClient } from "../src/hub/client.ts"
import { FakeHub } from "../src/hub/fake/FakeHub.ts"
import { demoSessionId } from "../src/hub/fake/script.ts"
import { findSession } from "../src/hub/store.ts"
import type { HubTransport, SocketHandlers } from "../src/hub/transport.ts"
import { alice } from "./fixtures.ts"

const demo = SessionId.make(demoSessionId)
const decodedAlice = Schema.decodeUnknownSync(Participant)(alice)
/** A transport's CLI approval, which these tests never use. */
const unused = async (): Promise<never> => {
  throw new Error("unused")
}
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
    expect(client.getState().you?.login).toBe("alice")
    // The Runners and Sessions come after the welcome, each list a message of its own.
    await eventually(() => {
      const state = client.getState()
      expect(state.runners?.map((runner) => runner.name)).toEqual(["studio", "ci-box"])
      expect(state.sessions?.map((session) => session.id)).toContain(demo)
    })
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
      signInStatus: async () => ({ signedIn: true, you: decodedAlice }),
      devSignIn: async () => {},
      signOut: async () => {},
      approveCli: unused,
      admit: unused,
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
      signInStatus: async () => ({ signedIn: true, you: decodedAlice }),
      devSignIn: async () => {},
      signOut: async () => {},
      approveCli: unused,
      admit: unused,
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
      approveCli: unused,
      admit: unused,
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
    // Idle comes in the SessionUpdated after the TurnEnded, a message of its own.
    await eventually(() => {
      const session = client.getState().sessions?.find((candidate) => candidate.id === demo)
      expect(session?.currentTurn).toBeNull()
    })
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

  test("a queued prompt steered into the running Turn joins it, and leaves the queue (#195)", async () => {
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
    client.steerPrompt(demo, queued.id)
    await eventually(() => expect(client.getState().joined[demo]?.queue).toEqual([]))
    expect(hub.received).toContainEqual({
      _tag: "SteerPrompt",
      sessionId: demo,
      promptId: queued.id,
    })
    await eventually(() =>
      expect(client.getState().joined[demo]?.log.map((entry) => entry.event._tag)).toContain(
        "SteeredPromptRead",
      ),
    )
    // It joined the Turn "First" started, and started none of its own.
    const events = (client.getState().joined[demo]?.log ?? []).map((entry) => entry.event)
    const started = events.flatMap((event) => (event._tag === "TurnStarted" ? [event] : []))
    const steered = events.find((event) => event._tag === "PromptSteered")
    expect(steered).toMatchObject({ promptId: queued.id, text: "Second" })
    expect(started.some((event) => event.text.endsWith("Second"))).toBe(false)
    const turnId = steered?._tag === "PromptSteered" ? steered.turnId : undefined
    expect(turnId).toBe(started.at(-1)?.turnId)
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
      repo: "kddige/kndl",
      baseBranch: "main",
      runnerId: RunnerId.make("r-studio"),
    })
    expect(session).toMatchObject({
      repo: "kddige/kndl",
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
        repo: "kddige/kndl",
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
      signInStatus: async () => ({ signedIn: true, you: decodedAlice }),
      devSignIn: async () => {},
      signOut: async () => {},
      approveCli: unused,
      admit: unused,
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

    // The state moves with the logged SessionStateChanged; who archived it, and when, come in the
    // SessionUpdated that follows it as a message of its own. So wait for those, not the state.
    expect(client.archiveSession(readme)).toBe(true)
    await eventually(() => expect(find(client, readme)?.archived?.by.login).toBe("alice"))
    expect(find(client, readme)?.state).toBe("Archived")
    const archived = find(client, readme)?.archived
    expect(archived && archived.purgeAt - archived.at).toBe(30 * 24 * 3_600_000)
    const log = () => client.getState().joined[readme]?.log.map((entry) => entry.event) ?? []
    expect(log().at(-1)).toMatchObject({ _tag: "SessionStateChanged", state: "Archived" })

    expect(client.restoreSession(readme)).toBe(true)
    await eventually(() => expect(find(client, readme)?.archived).toBeUndefined())
    expect(find(client, readme)?.state).toBe("Asleep")
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

/** A client of a fresh fake Hub, once online. */
async function online() {
  const set = setUp()
  set.client.start()
  await eventually(() => expect(set.client.getState().connection.status).toBe("online"))
  return set
}

describe("Environments", () => {
  const repo = "kddige/kndl"
  const studio = RunnerId.make("r-studio")

  /** The fake's saved Environment as a draft, changed by `change`. */
  async function draftOf(
    client: HubClient,
    change: (saved: EnvironmentDraft) => EnvironmentDraft = (saved) => saved,
  ) {
    const { environment } = await client.getEnvironment(repo)
    return { base: environment?.version ?? null, draft: change(toDraft(editFrom(environment))) }
  }

  test("getEnvironment answers with the versions, and the store keeps them", async () => {
    const { client } = await online()
    const state = await client.getEnvironment(repo)
    expect(state.environment?.version).toBe(2 as never)
    expect(state.versions.map((version) => `${version.version}:${version.rebuilt}`)).toEqual([
      "2:false",
      "1:true",
    ])
    expect(client.getState().environments[repo]?.environment?.image).toBe("debian:bookworm-slim")
    // Saved Sensitive values never reach the browser.
    expect(JSON.stringify(client.getState().environments[repo])).not.toContain("made-up")
    const none = await client.getEnvironment("acme/new")
    expect(none).toMatchObject({ environment: null, versions: [] })
  })

  test("a change to the build needs a passing Test build of exactly that draft", async () => {
    const { client } = await online()
    const { base, draft } = await draftOf(client, (saved) => ({ ...saved, image: "ubuntu:24.04" }))
    expect(await client.checkEnvironmentDraft(repo, draft)).toMatchObject({
      needsTestBuild: true,
      testBuildPassed: false,
    })
    await expect(client.applyEnvironment(repo, base, draft)).rejects.toThrow("run a Test build")

    const build = await client.startTestBuild(repo, studio, draft)
    await eventually(() => expect(client.getState().testBuilds[build.id]?.result).toBe("Passed"))
    expect(client.getState().testBuilds[build.id]?.log).toContain("Pulling ubuntu:24.04")
    expect((await client.checkEnvironmentDraft(repo, draft)).testBuildPassed).toBe(true)
    // Another draft hasn't passed.
    const other = { ...draft, image: "ubuntu:22.04" }
    expect((await client.checkEnvironmentDraft(repo, other)).testBuildPassed).toBe(false)

    const applied = await client.applyEnvironment(repo, base, draft)
    expect(applied.environment?.version).toBe(3 as never)
    expect(applied.versions[0]).toMatchObject({
      version: 3,
      rebuilt: true,
      appliedBy: { login: "alice" },
    })
  })

  test("a failing bootstrap fails the Test build, with its log", async () => {
    const { client } = await online()
    const { draft } = await draftOf(client, (saved) => ({ ...saved, bootstrapScript: "false" }))
    const build = await client.startTestBuild(repo, studio, draft)
    await eventually(() => expect(client.getState().testBuilds[build.id]?.result).toBe("Failed"))
    expect(client.getState().testBuilds[build.id]?.log).toContain("exited with status 1")
  })

  test("a change that doesn't touch the build applies at once, Sensitive values kept", async () => {
    const { client } = await online()
    const { base, draft } = await draftOf(client, (saved) => ({
      ...saved,
      resources: { cpus: 8, memoryMib: 16_384 },
    }))
    expect(await client.checkEnvironmentDraft(repo, draft)).toMatchObject({
      needsTestBuild: false,
    })
    const applied = await client.applyEnvironment(repo, base, draft)
    expect(applied.versions[0]).toMatchObject({ version: 3, rebuilt: false })
    expect(applied.environment?.variables.map((variable) => variable._tag)).toEqual([
      "Plain",
      "Sensitive",
      "Link",
    ])
  })

  test("a draft made from an older version is refused, and others hear of the new one", async () => {
    const { hub, client } = await online()
    const { base, draft } = await draftOf(client, (saved) => ({
      ...saved,
      resources: { cpus: 8, memoryMib: 4096 },
    }))
    hub.teammateApplies(repo)
    await eventually(() =>
      expect(client.getState().environments[repo]?.environment?.version).toBe(3 as never),
    )
    expect(client.getState().environments[repo]?.versions[0]?.appliedBy.login).toBe("bob")
    await expect(client.applyEnvironment(repo, base, draft)).rejects.toThrow(
      "version 3 is the latest",
    )
  })

  test("a Repo's first Environment, from the default draft, lets it have Sessions", async () => {
    const { client } = await online()
    await expect(client.createSession({ repo: "acme/new", baseBranch: "main" })).rejects.toThrow(
      "acme/new has no Environment yet",
    )
    const build = await client.startTestBuild("acme/new", studio, DefaultEnvironmentDraft)
    await eventually(() => expect(client.getState().testBuilds[build.id]?.result).toBe("Passed"))
    const applied = await client.applyEnvironment("acme/new", null, DefaultEnvironmentDraft)
    expect(applied.environment?.version).toBe(1 as never)
    const session = await client.createSession({ repo: "acme/new", baseBranch: "main" })
    // Being started on version 1, it runs on none until its Runner says it started (#70).
    expect(session.environment).toEqual({ version: null, latestVersion: 1 as never })
    expect(session.starting?.environmentVersion).toBe(1 as never)
    await eventually(() =>
      expect(findSession(client.getState(), session.id)?.environment?.version).toBe(1 as never),
    )
    expect(findSession(client.getState(), session.id)?.starting).toBeUndefined()
  })

  test("Sessions hear of a newer version, and a restart puts them on it", async () => {
    const { client } = await online()
    const { base, draft } = await draftOf(client, (saved) => ({
      ...saved,
      resources: { cpus: 3, memoryMib: 4096 },
    }))
    await client.applyEnvironment(repo, base, draft)
    await eventually(() =>
      expect(find(client, demoSessionId)?.environment).toEqual({
        version: 1 as never,
        latestVersion: 3 as never,
      }),
    )
    const failures: Array<CommandFailed> = []
    client.onCommandFailed((failure) => failures.push(failure))
    expect(client.restartSession(demo)).toBe(true)
    // Restarting shows until it is back, and another restart meanwhile is refused (#70).
    await eventually(() => expect(find(client, demoSessionId)?.restarting?.by.login).toBeDefined())
    expect(client.restartSession(demo)).toBe(true)
    await eventually(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({
      command: "RestartSession",
      message: "The Session is already restarting.",
    })
    await eventually(() =>
      expect(find(client, demoSessionId)?.environment).toEqual({
        version: 3 as never,
        latestVersion: 3 as never,
      }),
    )
    expect(find(client, demoSessionId)?.state).toBe("Active")
    expect(find(client, demoSessionId)?.restarting).toBeUndefined()
    expect(find(client, demoSessionId)?.starting).toBeUndefined()
  })

  test("shared variables: added, replaced write-only, and not deleted while linked", async () => {
    const { client } = await online()
    const listed = await client.getSharedVariables()
    expect(listed.find((variable) => variable.name === "GH_READ_TOKEN")).toEqual({
      _tag: "Sensitive",
      name: "GH_READ_TOKEN",
      linkedBy: [{ repo: repo as never, name: "GITHUB_TOKEN", availableAtBuild: false }],
      needsValue: false,
    })
    const added = await client.setSharedVariable({
      _tag: "Sensitive",
      name: "API_KEY",
      value: Redacted.make("made-up-api-key"),
    })
    expect(added.find((variable) => variable.name === "API_KEY")).toEqual({
      _tag: "Sensitive",
      name: "API_KEY",
      linkedBy: [],
      needsValue: false,
    })
    expect(JSON.stringify(client.getState().sharedVariables)).not.toContain("made-up")
    // Saved again without a value, it keeps the one it has.
    await client.setSharedVariable({ _tag: "Sensitive", name: "API_KEY" })
    await expect(
      client.setSharedVariable({ _tag: "Sensitive", name: "SHORT", value: Redacted.make("abc") }),
    ).rejects.toThrow("under 4 characters")

    await expect(client.deleteSharedVariable("GH_READ_TOKEN")).rejects.toThrow(
      "GH_READ_TOKEN is linked in kddige/kndl",
    )
    const left = await client.deleteSharedVariable("API_KEY")
    expect(left.map((variable) => variable.name)).not.toContain("API_KEY")
  })
})

/** The one of `all` named `name`: the test fails without one. */
function named<T extends { readonly name: string }>(
  all: ReadonlyArray<T> | undefined,
  name: string,
): T {
  const one = all?.find((each) => each.name === name)
  if (one === undefined) throw new Error(`Nothing named ${name}`)
  return one
}

/** A Plugin's auth when it declares no header secrets. */
const none = { _tag: "None" } as const

describe("Plugins (ADR 0020)", () => {
  const repo = "kddige/kndl"

  test("a Member creates, edits and deletes a Hub-only Plugin, with a hub: id", async () => {
    const { client } = await online()
    const created = await client.createPlugin("Acme docs", "https://mcp.acme.example/mcp", none)
    const plugin = named(created.plugins, "Acme docs")
    expect(plugin).toMatchObject({ id: "hub:acme-docs", createdBy: { login: "alice" } })
    // Another of the same name gets a number; its id never clashes with an npm package's.
    const again = await client.createPlugin("Acme docs", "https://mcp.acme.example/two", none)
    expect(again.plugins.map((one) => one.id)).toContain("hub:acme-docs-2" as never)
    await expect(client.createPlugin("Bad", "ftp://x.example", none)).rejects.toThrow("https://")

    const edited = await client.editPlugin(plugin.id, "Acme", "https://mcp.acme.example/v2", none)
    expect(edited.plugins.find((one) => one.id === plugin.id)).toMatchObject({
      name: "Acme",
      url: "https://mcp.acme.example/v2",
    })
    const left = await client.deletePlugin(plugin.id)
    expect(left.plugins.map((one) => one.id)).not.toContain(plugin.id)
    expect(client.getState().plugins?.plugins).toEqual(left.plugins)
  })

  test("header secrets: values are write-only, and a URL on another server clears them", async () => {
    const { client } = await online()
    const auth = {
      _tag: "Headers",
      headers: [
        { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    } as const
    await expect(
      client.createPlugin("Acme", "https://mcp.acme.example/mcp", {
        _tag: "Headers",
        headers: [{ ...auth.headers[0], template: "Bearer" }],
      }),
    ).rejects.toThrow("{value}")
    const created = await client.createPlugin("Acme", "https://mcp.acme.example/mcp", auth)
    const plugin = named(created.plugins, "Acme")
    expect(plugin.auth).toEqual(auth)

    const value = Redacted.make("made-up-acme-key")
    await expect(
      client.createInstallation(
        plugin.id,
        "Acme",
        [repo],
        [{ key: "nope", value: Redacted.make("made-up") }],
      ),
    ).rejects.toThrow("Acme has no header secret nope.")
    const installed = await client.createInstallation(
      plugin.id,
      "Acme",
      [repo],
      [{ key: "api_key", value }],
    )
    const installation = named(installed.installations, "Acme")
    expect(installation.values).toEqual([
      {
        key: "api_key",
        setBy: expect.objectContaining({ login: "alice" }),
        setAt: expect.any(Number),
      },
    ])
    await eventually(() =>
      expect(client.getState().pluginLogs[repo]?.[0]).toMatchObject({
        change: "ValuesSet",
        installationName: "Acme",
        secrets: ["API key"],
      }),
    )
    expect(JSON.stringify(client.getState())).not.toContain("made-up-acme-key")

    // Another path on the same server keeps the values; another server clears them.
    const moved = await client.editPlugin(plugin.id, "Acme", "https://mcp.acme.example/v2", auth)
    expect(named(moved.installations, "Acme").values).toHaveLength(1)
    const elsewhere = await client.editPlugin(plugin.id, "Acme", "https://acme.example/mcp", auth)
    expect(named(elsewhere.installations, "Acme").values).toEqual([])
    await eventually(() =>
      expect(client.getState().pluginLogs[repo]?.[0]).toMatchObject({
        change: "ValuesCleared",
        secrets: ["API key"],
      }),
    )
  })

  test("a Plugin with Installations can't be deleted", async () => {
    const { client } = await online()
    const { plugins } = await client.getPlugins()
    const docs = named(plugins, "Docs search")
    await expect(client.deletePlugin(docs.id)).rejects.toThrow(
      "Docs search has an Installation: delete it first.",
    )
  })

  test("Installations: only on Repos the person has access to, without naming the others", async () => {
    const { client } = await online()
    const { plugins, installations } = await client.getPlugins()
    const linear = named(plugins, "Linear")
    // A refusal for a Repo out of reach reads the same whether it exists or not.
    await expect(
      client.createInstallation(linear.id, "Linear", [repo, "kddige/secret"]),
    ).rejects.toThrow("You have no access to kddige/secret on GitHub")
    // One the person can see only partly: shown without the other Repos, and not changeable.
    const sentry = named(installations, "Sentry")
    expect(sentry).toMatchObject({ repos: [repo], otherRepos: 1 })
    expect(JSON.stringify(client.getState().plugins)).not.toContain("kddige/secret")
    await expect(client.deleteInstallation(sentry.id)).rejects.toThrow(
      "This Installation is on in Repos you have no access to",
    )

    const created = await client.createInstallation(linear.id, "Linear", [repo])
    const installation = created.installations.find((one) => one.pluginId === linear.id)
    if (installation === undefined) throw new Error("No Installation of Linear")
    expect(installation).toMatchObject({ name: "Linear", repos: [repo] })
    const moved = await client.editInstallation(installation.id, "Linear", ["kddige/dotfiles"])
    expect(moved.installations.find((one) => one.id === installation.id)?.repos).toEqual([
      "kddige/dotfiles",
    ])
    const gone = await client.deleteInstallation(installation.id)
    expect(gone.installations.map((one) => one.id)).not.toContain(installation.id)
  })

  test("a second Installation of a Plugin on a Repo is refused, naming the existing one", async () => {
    const { client } = await online()
    const { plugins } = await client.getPlugins()
    const docs = named(plugins, "Docs search")
    await expect(client.createInstallation(docs.id, "More docs", ["KDDIGE/kndl"])).rejects.toThrow(
      "KDDIGE/kndl already has Docs, an Installation of Docs search",
    )
  })

  test("each Repo's change log says who changed its Installations", async () => {
    const { client } = await online()
    const { plugins } = await client.getPlugins()
    const linear = named(plugins, "Linear")
    const before = await client.getPluginLog(repo)
    expect(before.map((entry) => entry.change)).toEqual(["Created", "Created"])
    await client.createInstallation(linear.id, "Linear", [repo])
    await eventually(() =>
      expect(client.getState().pluginLogs[repo]?.[0]).toMatchObject({
        change: "Created",
        by: { login: "alice" },
        pluginName: "Linear",
        installationName: "Linear",
      }),
    )
    await expect(client.getPluginLog("kddige/secret")).rejects.toThrow("no access")
  })

  test("a Session shows its Installations, and that a Restart applies a change", async () => {
    const { client } = await online()
    await eventually(() =>
      expect(find(client, demoSessionId)?.plugins?.map((one) => one.server)).toEqual([
        "docs",
        "sentry",
      ]),
    )
    expect(find(client, demoSessionId)?.pluginsChanged).toBeUndefined()
    const { plugins } = await client.getPlugins()
    const linear = named(plugins, "Linear")
    await client.createInstallation(linear.id, "Linear", [repo])
    await eventually(() => expect(find(client, demoSessionId)?.pluginsChanged).toBe(true))

    expect(client.restartSession(demo)).toBe(true)
    await eventually(() => {
      const session = find(client, demoSessionId)
      expect(session?.restarting).toBeUndefined()
      expect(session?.starting).toBeUndefined()
      expect(session?.plugins?.map((one) => one.server)).toEqual(["docs", "sentry", "linear"])
    })
    expect(find(client, demoSessionId)?.pluginsChanged).toBeUndefined()
  })
})
