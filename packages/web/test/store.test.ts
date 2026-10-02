import { describe, expect, test } from "bun:test"
import type { SessionId } from "@claude-hub/protocol"
import {
  appendEntries,
  findSession,
  type HubAction,
  type HubState,
  initialState,
  lastSeq,
  reduce,
} from "../src/hub/store.ts"
import {
  alice,
  bob,
  entries,
  fromAlice,
  history,
  hub,
  logged,
  runnerLogin,
  sessionSummary,
  welcome,
} from "./fixtures.ts"

const s1 = "s-1" as SessionId
const s2 = "s-2" as SessionId

function run(...actions: ReadonlyArray<HubAction>): HubState {
  return actions.reduce(reduce, initialState)
}

const joined: HubAction = { _tag: "Joined", sessionId: s1 }
const listed = hub({ _tag: "SessionList", sessions: [sessionSummary] })

const turnStart = {
  _tag: "TurnStarted",
  turnId: "t-1",
  text: "[Alice] hi",
  sender: fromAlice,
} as const
const delta = (text: string) => ({ _tag: "TextDelta", turnId: "t-1", text }) as const

describe("connection", () => {
  test("starts connecting, with nothing known", () => {
    expect(initialState.connection).toEqual({ status: "connecting", attempt: 0 })
    expect(initialState.you).toBeNull()
    expect(initialState.runners).toBeNull()
    expect(initialState.sessions).toBeNull()
    expect(initialState.joined).toEqual({})
  })

  test("ConnectionChanged replaces the connection", () => {
    const state = run({
      _tag: "ConnectionChanged",
      connection: { status: "signedOut", options: { github: true, dev: false } },
    })
    expect(state.connection).toEqual({ status: "signedOut", options: { github: true, dev: false } })
  })

  test("the welcome says who you are and brings the connection online", () => {
    const state = run(
      { _tag: "ConnectionChanged", connection: { status: "connecting", attempt: 2 } },
      welcome(),
    )
    expect(state.connection).toEqual({ status: "online" })
    expect(state.you?.login).toBe(alice.login)
  })

  test("HandshakeRejected keeps the Hub's message", () => {
    const state = run(
      hub({
        _tag: "HandshakeRejected",
        reason: "ProtocolVersionMismatch",
        protocolVersion: 2,
        message: "Update the peer.",
      }),
    )
    expect(state.connection).toEqual({ status: "rejected", message: "Update the peer." })
  })
})

describe("Runners and Sessions", () => {
  test("RunnerList and SessionList replace what was known", () => {
    const runner = { id: "r-1", name: "studio", login: runnerLogin, isOnline: true }
    let state = run(
      hub({ _tag: "RunnerList", runners: [runner] }),
      listed,
      hub({ _tag: "RunnerList", runners: [{ ...runner, isOnline: false }] }),
    )
    expect(state.runners?.map((r) => r.isOnline)).toEqual([false])
    expect(state.sessions?.map((s) => s.id)).toEqual([s1])

    state = reduce(state, hub({ _tag: "SessionList", sessions: [] }))
    expect(state.sessions).toEqual([])
  })

  test("SessionUpdated replaces a Session in place and adds an unknown one", () => {
    const state = run(
      hub({ _tag: "SessionList", sessions: [sessionSummary, { ...sessionSummary, id: "s-2" }] }),
      hub({ _tag: "SessionUpdated", session: { ...sessionSummary, state: "Asleep" } }),
      hub({ _tag: "SessionUpdated", session: { ...sessionSummary, id: "s-3" } }),
    )
    expect(state.sessions?.map((s) => [String(s.id), s.state])).toEqual([
      ["s-1", "Asleep"],
      ["s-2", "Active"],
      ["s-3", "Active"],
    ])
  })

  test("SessionUpdated before any SessionList starts the list", () => {
    const state = run(hub({ _tag: "SessionUpdated", session: sessionSummary }))
    expect(state.sessions?.map((s) => s.id)).toEqual([s1])
  })

  test("SessionCreated adds the new Session", () => {
    const state = run(
      listed,
      hub({ _tag: "SessionCreated", requestId: "q-1", session: { ...sessionSummary, id: "s-2" } }),
    )
    expect(state.sessions?.map((s) => s.id)).toEqual([s1, s2])
    expect(findSession(state, "s-2")?.id).toBe(s2)
    expect(findSession(state, "nope")).toBeUndefined()
  })
})

describe("joining and leaving", () => {
  test("Joined starts an empty Session that waits for its history", () => {
    const state = run(joined)
    expect(state.joined[s1]).toEqual({ historyLoaded: false, log: [], presence: [], queue: [] })
  })

  test("Joined again keeps what is known", () => {
    const before = run(joined, history([turnStart]))
    expect(reduce(before, joined)).toBe(before)
  })

  test("Left forgets the Session; leaving one not joined changes nothing", () => {
    const state = run(joined, { _tag: "Joined", sessionId: s2 }, { _tag: "Left", sessionId: s1 })
    expect(Object.keys(state.joined)).toEqual([s2])
    expect(reduce(state, { _tag: "Left", sessionId: s1 })).toBe(state)
  })

  test("messages for a Session not joined are dropped", () => {
    const state = run(listed)
    for (const message of [
      history([turnStart]),
      logged(0, turnStart),
      hub({ _tag: "PresenceChanged", sessionId: "s-1", participants: [alice] }),
      hub({ _tag: "PromptQueueChanged", sessionId: "s-1", queue: [] }),
      logged(0, { _tag: "SessionStateChanged", state: "Frozen" }),
    ]) {
      expect(reduce(state, message)).toBe(state)
    }
  })
})

describe("the event log", () => {
  test("SessionHistory loads the log", () => {
    const state = run(joined, history([turnStart, delta("Hel"), delta("lo")]))
    const session = state.joined[s1]
    expect(session?.historyLoaded).toBe(true)
    expect(session?.log.map((entry) => Number(entry.seq))).toEqual([0, 1, 2])
    expect(lastSeq(session?.log ?? [])).toBe(2 as never)
  })

  test("an empty SessionHistory still marks the history loaded", () => {
    const state = run(joined, history([]))
    expect(state.joined[s1]).toMatchObject({ historyLoaded: true, log: [] })
  })

  test("SessionEventLogged appends live entries in order", () => {
    const state = run(joined, history([turnStart]), logged(1, delta("a")), logged(2, delta("b")))
    expect(state.joined[s1]?.log.map((entry) => Number(entry.seq))).toEqual([0, 1, 2])
  })

  test("an entry already held is not added twice", () => {
    const once = run(joined, history([turnStart, delta("a")]))
    const twice = reduce(once, logged(1, delta("a")))
    expect(twice.joined[s1]?.log).toHaveLength(2)
  })

  test("the history after a reconnect adds only what's new, even if it overlaps", () => {
    const before = run(joined, history([turnStart, delta("a"), delta("b")]))
    // The Hub answers JoinSession { afterSeq: 2 } from 3, but an overlap must not duplicate.
    const after = reduce(before, history([delta("b"), delta("c"), delta("d")], 2))
    expect(after.joined[s1]?.log.map((entry) => Number(entry.seq))).toEqual([0, 1, 2, 3, 4])
    expect(after.joined[s1]?.log[2]).toBe(before.joined[s1]?.log[2] as never)
  })

  test("a late entry is put in seq order", () => {
    const state = run(joined, history([turnStart]), logged(2, delta("b")), logged(1, delta("a")))
    expect(state.joined[s1]?.log.map((entry) => Number(entry.seq))).toEqual([0, 1, 2])
  })

  test("appendEntries keeps the same log when nothing is added", () => {
    const log = entries([turnStart, delta("a")])
    expect(appendEntries(log, [])).toBe(log)
    expect(appendEntries([], log)).toBe(log)
    expect(lastSeq([])).toBeUndefined()
  })

  test("a live SessionStateChanged moves the Session's state at once", () => {
    const state = run(
      listed,
      joined,
      history([]),
      logged(0, {
        _tag: "SessionStateChanged",
        state: "Frozen",
        message: "Runner studio is offline",
      }),
    )
    expect(findSession(state, "s-1")?.state).toBe("Frozen")
    expect(state.joined[s1]?.log).toHaveLength(1)
  })

  test("a state change the Session already shows changes only the log", () => {
    const before = run(listed, joined, history([]))
    const after = reduce(before, logged(0, { _tag: "SessionStateChanged", state: "Active" }))
    expect(after.sessions).toBe(before.sessions)
  })

  test("replayed state changes in the history leave the listed state alone", () => {
    const state = run(listed, joined, history([{ _tag: "SessionStateChanged", state: "Frozen" }]))
    expect(findSession(state, "s-1")?.state).toBe("Active")
  })
})

function queued(id: string, text: string, sender = alice) {
  return { id, text, sender, queuedAt: 1_790_000_000_100 }
}

describe("presence and the Prompt queue", () => {
  test("PresenceChanged replaces who's here", () => {
    const state = run(
      joined,
      hub({ _tag: "PresenceChanged", sessionId: "s-1", participants: [alice, bob] }),
      hub({ _tag: "PresenceChanged", sessionId: "s-1", participants: [bob] }),
    )
    expect(state.joined[s1]?.presence.map((p) => p.login)).toEqual(["bob"])
  })

  test("PromptQueueChanged replaces the queue, in order", () => {
    let state = run(
      joined,
      hub({
        _tag: "PromptQueueChanged",
        sessionId: "s-1",
        queue: [queued("p-1", "first"), queued("p-2", "second", bob)],
      }),
    )
    expect(state.joined[s1]?.queue.map((p) => String(p.id))).toEqual(["p-1", "p-2"])
    state = reduce(state, hub({ _tag: "PromptQueueChanged", sessionId: "s-1", queue: [] }))
    expect(state.joined[s1]?.queue).toEqual([])
  })

  test("leaving and joining again starts from nothing", () => {
    const state = run(
      joined,
      history([turnStart]),
      hub({ _tag: "PresenceChanged", sessionId: "s-1", participants: [alice] }),
      { _tag: "Left", sessionId: s1 },
      joined,
    )
    expect(state.joined[s1]).toEqual({ historyLoaded: false, log: [], presence: [], queue: [] })
  })
})

test("terminal frames and refused commands leave the state alone", () => {
  const state = run(listed, joined)
  expect(
    reduce(
      state,
      hub({
        _tag: "TerminalFrame",
        sessionId: "s-1",
        kind: "Output",
        data: "x",
        size: { cols: 80, rows: 24 },
      }),
    ),
  ).toBe(state)
  expect(reduce(state, hub({ _tag: "CommandFailed", command: "SendPrompt", message: "no" }))).toBe(
    state,
  )
})
