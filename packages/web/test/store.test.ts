import { describe, expect, test } from "bun:test"
import type { SessionId, TerminalFrame } from "@claude-hub/protocol"
import {
  acceptsFrame,
  appendEntries,
  findSession,
  type HubAction,
  type HubState,
  initialState,
  isListed,
  lastSeq,
  reduce,
  startLogLimit,
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

  test("SessionRemoved drops a purged Session, and its joined copy", () => {
    const state = run(
      hub({ _tag: "SessionList", sessions: [sessionSummary, { ...sessionSummary, id: "s-2" }] }),
      joined,
      hub({ _tag: "SessionRemoved", sessionId: "s-1" }),
    )
    expect(state.sessions?.map((s) => s.id)).toEqual([s2])
    expect(state.joined[s1]).toBeUndefined()
  })

  test("an Archived Session stays known but isn't listed", () => {
    const archived = {
      ...sessionSummary,
      id: "s-2",
      state: "Archived",
      archived: { by: bob, at: 1, purgeAt: 2 },
    } as const
    const state = run(hub({ _tag: "SessionList", sessions: [sessionSummary, archived] }))
    expect(findSession(state, "s-2")?.archived?.by.name).toBe("Bob")
    expect(state.sessions?.filter(isListed).map((s) => s.id)).toEqual([s1])
  })
})

describe("joining and leaving", () => {
  test("Joined starts an empty Session that waits for its history", () => {
    const state = run(joined)
    expect(state.joined[s1]).toEqual({
      historyLoaded: false,
      log: [],
      presence: [],
      queue: [],
      startLog: null,
    })
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
    expect(state.joined[s1]).toEqual({
      historyLoaded: false,
      log: [],
      presence: [],
      queue: [],
      startLog: null,
    })
  })
})

function startLogged(since: number, data: string, replace?: boolean) {
  return hub({
    _tag: "SessionStartLogged",
    sessionId: "s-1",
    since,
    data,
    ...(replace !== undefined && { replace }),
  })
}

describe("the start log", () => {
  test("a start's output adds up; all of it so far, or another start's, replaces it", () => {
    let state = run(joined, startLogged(1, "Step 1\r\n"), startLogged(1, "Step 2\r\n"))
    expect(state.joined[s1]?.startLog).toEqual({ since: 1, text: "Step 1\r\nStep 2\r\n" })
    state = reduce(state, startLogged(1, "Step 1\r\nStep 2\r\nStep 3\r\n", true))
    expect(state.joined[s1]?.startLog?.text).toBe("Step 1\r\nStep 2\r\nStep 3\r\n")
    state = reduce(state, startLogged(2, "again\r\n"))
    expect(state.joined[s1]?.startLog).toEqual({ since: 2, text: "again\r\n" })
  })

  test("only its end is kept, and a Session not joined drops it", () => {
    const long = "x".repeat(startLogLimit)
    const state = run(joined, startLogged(1, long), startLogged(1, "end"))
    expect(state.joined[s1]?.startLog?.text.length).toBe(startLogLimit)
    expect(state.joined[s1]?.startLog?.text.endsWith("xend")).toBe(true)
    expect(run(startLogged(1, "nobody")).joined).toEqual({})
  })
})

function frame(kind: "Snapshot" | "Output", cols = 80, sessionId = "s-1") {
  return hub({ _tag: "TerminalFrame", sessionId, kind, data: "x", size: { cols, rows: 24 } })
}

describe("terminals", () => {
  const opened: HubAction = { _tag: "TerminalOpened", sessionId: s1 }

  test("an opened terminal waits for a Snapshot, then is live at its size", () => {
    expect(run(opened).terminals[s1]).toEqual({ status: "waiting", size: null })
    expect(run(opened, frame("Snapshot")).terminals[s1]).toEqual({
      status: "live",
      size: { cols: 80, rows: 24 },
    })
  })

  test("Output before the Snapshot is dropped, and acceptsFrame says so", () => {
    const waiting = run(opened)
    expect(reduce(waiting, frame("Output"))).toBe(waiting)
    const terminal = waiting.terminals[s1]
    if (!terminal) throw new Error("not open")
    expect(acceptsFrame(terminal, frame("Output") as TerminalFrame)).toBe(false)
    expect(acceptsFrame(terminal, frame("Snapshot") as TerminalFrame)).toBe(true)
  })

  test("Output at the same size changes nothing; a new size is kept", () => {
    const live = run(opened, frame("Snapshot"))
    expect(reduce(live, frame("Output"))).toBe(live)
    expect(reduce(live, frame("Output", 100)).terminals[s1]?.size).toEqual({ cols: 100, rows: 24 })
  })

  test("frames for a terminal not open are dropped", () => {
    const state = run(listed, joined)
    expect(reduce(state, frame("Snapshot"))).toBe(state)
    expect(reduce(state, frame("Output"))).toBe(state)
  })

  test("losing the connection sends every terminal back to waiting, keeping its size", () => {
    const state = run(opened, { _tag: "TerminalOpened", sessionId: s2 }, frame("Snapshot"), {
      _tag: "ConnectionChanged",
      connection: { status: "reconnecting", attempt: 1 },
    })
    expect(state.terminals).toEqual({
      [s1]: { status: "waiting", size: { cols: 80, rows: 24 } },
      [s2]: { status: "waiting", size: null },
    })
    // So the Output of the old connection is dropped, until the new Snapshot.
    expect(reduce(state, frame("Output"))).toBe(state)
    expect(reduce(state, frame("Snapshot", 90)).terminals[s1]?.status).toBe("live")
  })

  test("opening again waits for a new Snapshot; closing forgets the terminal", () => {
    const live = run(opened, frame("Snapshot"))
    expect(reduce(live, opened).terminals[s1]).toEqual({
      status: "waiting",
      size: { cols: 80, rows: 24 },
    })
    expect(reduce(live, { _tag: "TerminalClosed", sessionId: s1 }).terminals).toEqual({})
    expect(reduce(live, { _tag: "TerminalClosed", sessionId: s2 })).toBe(live)
  })
})

test("refused commands leave the state alone", () => {
  const state = run(listed, joined)
  expect(reduce(state, hub({ _tag: "CommandFailed", command: "SendPrompt", message: "no" }))).toBe(
    state,
  )
})

describe("Environments", () => {
  const environment = {
    repo: "acme/app",
    version: 2,
    image: "debian:bookworm-slim",
    bootstrapScript: "",
    docker: false,
    dependencyFolders: [],
    resources: { cpus: 2, memoryMib: 4096 },
    variables: [{ _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true }],
  } as const
  const versions = [
    { version: 2, appliedBy: bob, appliedAt: 2_000, rebuilt: false },
    { version: 1, appliedBy: alice, appliedAt: 1_000, rebuilt: true },
  ]
  const testBuild = {
    id: "tb-1",
    repo: "acme/app",
    runnerId: "r-1",
    startedBy: alice,
    startedAt: 3_000,
  }

  test("EnvironmentState keeps a Repo's Environment and versions, answered or broadcast", () => {
    const state = run(
      hub({
        _tag: "EnvironmentState",
        requestId: "q-1",
        repo: "acme/app",
        environment: null,
        versions: [],
      }),
      hub({ _tag: "EnvironmentState", repo: "acme/app", environment, versions }),
      hub({ _tag: "EnvironmentState", repo: "acme/other", environment: null, versions: [] }),
    )
    expect(state.environments["acme/app"]?.environment?.version).toBe(2 as never)
    expect(state.environments["acme/app"]?.versions.map((v) => v.appliedBy.name)).toEqual([
      "Bob",
      "Alice",
    ])
    expect(state.environments["acme/other"]).toEqual({ environment: null, versions: [] })
  })

  test("SharedVariables replaces what was known", () => {
    expect(initialState.sharedVariables).toBeNull()
    const state = run(
      hub({
        _tag: "SharedVariables",
        variables: [{ _tag: "Sensitive", name: "GH_TOKEN", linkedBy: [] }],
      }),
    )
    expect(state.sharedVariables?.map((variable) => variable.name)).toEqual(["GH_TOKEN"])
  })

  test("a Test build's log streams in until it ends, and says how", () => {
    const state = run(
      hub({ _tag: "TestBuildStarted", requestId: "q-2", testBuild }),
      hub({ _tag: "TestBuildLogged", testBuildId: "tb-1", data: "Pulling\n" }),
      hub({ _tag: "TestBuildLogged", testBuildId: "tb-1", data: "Built\n" }),
      hub({
        _tag: "TestBuildEnded",
        testBuildId: "tb-1",
        repo: "acme/app",
        result: "Failed",
        message: "exit 1",
      }),
      hub({ _tag: "TestBuildLogged", testBuildId: "tb-1", data: "late\n" }),
    )
    expect(state.testBuilds["tb-1" as never]).toMatchObject({
      log: "Pulling\nBuilt\n",
      result: "Failed",
      message: "exit 1",
    })
  })

  test("the log of a Test build this client didn't start is dropped, as is a check", () => {
    const state = run(hub({ _tag: "TestBuildLogged", testBuildId: "tb-9", data: "x" }))
    expect(state).toBe(initialState)
    const checked = hub({
      _tag: "EnvironmentDraftChecked",
      requestId: "q-3",
      repo: "acme/app",
      needsTestBuild: true,
      testBuildPassed: false,
    })
    expect(reduce(initialState, checked)).toBe(initialState)
  })
})
