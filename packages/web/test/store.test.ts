import { describe, expect, test } from "bun:test"
import {
  ProtocolVersion,
  RequestId,
  type SessionId,
  type SignInStep,
  type TerminalFrame,
} from "@kndl/protocol"
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
import { buildTranscript, emptyTranscript, type Transcript } from "../src/hub/transcript.ts"
import {
  alice,
  bob,
  entries,
  fromAlice,
  history,
  hub,
  logged,
  runnerSummary,
  sessionSummary,
  welcome,
} from "./fixtures.ts"

type SignInStepEncoded = (typeof SignInStep)["Encoded"]

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
  test("the welcome says who you are, whether you are the Hub's Owner, and brings the connection online", () => {
    const state = run(
      { _tag: "ConnectionChanged", connection: { status: "connecting", attempt: 2 } },
      welcome(),
    )
    expect(state.connection).toEqual({ status: "online" })
    expect(state.you?.login).toBe(alice.login)
    expect(state.owner).toBe(false)
    const owned = run(
      hub({ _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice, owner: true }),
    )
    expect(owned.owner).toBe(true)
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
    expect(state.connection).toEqual({
      status: "rejected",
      message: "Update the peer.",
      hubProtocol: 2,
    })
  })
})

describe("Runners and Sessions", () => {
  test("RunnerList and SessionList replace what was known", () => {
    const runner = runnerSummary
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

  test("RunnerRemoved drops the Runner before the RunnerList that follows it", () => {
    const state = run(
      hub({ _tag: "RunnerList", runners: [runnerSummary, { ...runnerSummary, id: "r-2" }] }),
      hub({ _tag: "RunnerRemoved", requestId: "q-1", runnerId: "r-1" }),
    )
    expect(state.runners?.map((r) => String(r.id))).toEqual(["r-2"])
  })

  test("the welcome says the Hub's commit, and the Pairing codes waiting are kept", () => {
    const pending = {
      id: "pc-1",
      createdBy: alice,
      createdAt: 1_790_000_000_000,
      expiresAt: 1_790_000_900_000,
    }
    const state = run(
      hub({
        _tag: "WebWelcome",
        protocolVersion: ProtocolVersion,
        you: alice,
        hub: { commit: "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1" },
      }),
      hub({ _tag: "PairingCodeList", codes: [pending] }),
    )
    expect(state.hubVersion?.commit).toBe("824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1")
    expect(state.pairingCodes?.map((code) => String(code.id))).toEqual(["pc-1"])
    expect(reduce(state, welcome()).hubVersion).toBeNull()
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
  test("a joined Session keeps the Models the Hub sends for it, its Creator's", () => {
    const models = [
      {
        provider: "anthropic",
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        thinkingLevels: [],
      },
    ] as const
    const state = run(
      joined,
      hub({ _tag: "SessionModels", sessionId: "s-1", models }),
      // Another Session's, not joined, are dropped.
      hub({ _tag: "SessionModels", sessionId: "s-2", models }),
    )
    expect(state.joined[s1]?.models?.map((model) => model.label)).toEqual(["Claude Opus 5.5"])
    expect(state.joined["s-2" as never]).toBeUndefined()
  })

  test("Joined starts an empty Session that waits for its history", () => {
    const state = run(joined)
    expect(state.joined[s1]).toEqual({
      historyLoaded: false,
      log: [],
      transcript: emptyTranscript,
      presence: [],
      queue: [],
      startLog: null,
      questionPicks: null,
      models: null,
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

/** A joined Session's transcript, which must be the one its whole log makes. */
function transcriptOf(state: HubState): Transcript {
  const session = state.joined[s1]
  if (!session) throw new Error("not joined")
  const { fold: _, ...transcript } = session.transcript
  expect(transcript).toEqual(buildTranscript(session.log))
  return transcript
}

/** The text of each Turn's text blocks. */
const textOf = (transcript: Transcript) =>
  transcript.items.flatMap((item) =>
    item.kind === "turn"
      ? item.turn.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []))
      : [],
  )

describe("the transcript", () => {
  const turnTwo = { ...turnStart, turnId: "t-2" } as const

  test("a joined Session's transcript grows with its log, leaving earlier Turns as they were", () => {
    const before = run(
      joined,
      history([
        turnStart,
        delta("Hi"),
        { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
        turnTwo,
      ]),
    )
    const after = reduce(before, logged(4, { _tag: "TextDelta", turnId: "t-2", text: "Again" }))
    expect(textOf(transcriptOf(after))).toEqual(["Hi", "Again"])
    expect(transcriptOf(after).running?.turnId).toBe("t-2" as never)
    expect(after.joined[s1]?.transcript.items[0]).toBe(
      before.joined[s1]?.transcript.items[0] as never,
    )
  })

  test("the history after a reconnect adds only what's new to the transcript", () => {
    const before = run(joined, history([turnStart, delta("a"), delta("b")]))
    const after = reduce(before, history([delta("b"), delta("c"), delta("d")], 2))
    expect(textOf(transcriptOf(after))).toEqual(["abcd"])
    expect(reduce(after, logged(3, delta("c"))).joined[s1]?.transcript).toBe(
      after.joined[s1]?.transcript as never,
    )
  })

  test("a late entry goes in its place in the transcript", () => {
    const state = run(joined, history([turnStart]), logged(2, delta("b")), logged(1, delta("a")))
    expect(textOf(transcriptOf(state))).toEqual(["ab"])
  })

  test("leaving forgets it, and joining again starts empty", () => {
    const state = run(
      joined,
      history([turnStart, delta("a")]),
      { _tag: "Left", sessionId: s1 },
      joined,
    )
    expect(transcriptOf(state).items).toEqual([])
  })
})

function queued(id: string, text: string, sender = alice) {
  return { id, text, sender, queuedAt: 1_790_000_000_100 }
}

describe("presence and the Prompt queue", () => {
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
      transcript: emptyTranscript,
      presence: [],
      queue: [],
      startLog: null,
      questionPicks: null,
      models: null,
    })
  })
})

function picks(answers: ReadonlyArray<string>) {
  return hub({
    _tag: "QuestionPicks",
    sessionId: "s-1",
    toolCallId: "call-1",
    picks: answers.map((answer) => ({ participant: bob, question: "Which?", answer })),
  })
}

describe("an Open question's picks (#193)", () => {
  test("QuestionPicks replaces what was picked, for its question", () => {
    const state = run(joined, history([turnStart]), picks(["date-fns"]), picks(["luxon"]))
    expect(state.joined[s1]?.questionPicks?.toolCallId).toBe("call-1" as never)
    expect(state.joined[s1]?.questionPicks?.picks.map((pick) => pick.answer)).toEqual(["luxon"])
  })

  test("a history after a reconnect forgets them, until the Hub shares them again", () => {
    const state = run(joined, history([turnStart]), picks(["date-fns"]), history([]))
    expect(state.joined[s1]?.questionPicks).toBeNull()
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

test("the GitHub App's permission check is kept, the latest in place of the one before", () => {
  const check = {
    slug: "kndl-alice",
    settingsUrl: "https://github.com/settings/apps/kndl-alice/permissions",
    installUrl: "https://github.com/apps/kndl-alice/installations/new",
    missing: [{ name: "issues", title: "Issues", access: "write" as const }],
    missingEvents: [],
    installed: 1,
    installations: [],
    checkedAt: 1,
  }
  expect(initialState.appPermissions).toBeNull()
  const drifted = run(hub({ _tag: "AppPermissionsChecked", check }))
  expect(drifted.appPermissions?.missing.map((permission) => permission.name)).toEqual(["issues"])
  const fixed = reduce(
    drifted,
    hub({ _tag: "AppPermissionsChecked", requestId: "q-1", check: { ...check, missing: [] } }),
  )
  expect(fixed.appPermissions?.missing).toEqual([])
})

test("the Hub's update check comes in the Owner's welcome, then after each check (ADR 0028)", () => {
  const follows = { _tag: "Channel", channel: "stable" } as const
  expect(run(welcome()).hubUpdate).toBeNull()
  const welcomed = run(
    hub({
      _tag: "WebWelcome",
      protocolVersion: ProtocolVersion,
      you: alice,
      owner: true,
      hubUpdate: { follows },
    }),
  )
  expect(welcomed.hubUpdate).toEqual({ follows })
  const checked = reduce(
    welcomed,
    hub({
      _tag: "HubUpdateChecked",
      update: { follows, checked: { at: 5, found: { _tag: "UpToDate" } } },
    }),
  )
  expect(checked.hubUpdate?.checked).toEqual({ at: 5, found: { _tag: "UpToDate" } })
})

test("the Hub's latest update comes in the Owner's welcome, then as it changes (#362)", () => {
  const status = {
    id: "u-1",
    source: "hub",
    startedAt: 1,
    from: { commit: "a".repeat(40) },
    step: "Fetching",
    state: "Running",
  } as const
  expect(run(welcome()).hubUpdateRun).toBeNull()
  const welcomed = run(
    hub({
      _tag: "WebWelcome",
      protocolVersion: ProtocolVersion,
      you: alice,
      owner: true,
      hubUpdate: { follows: { _tag: "Channel", channel: "stable" } },
      hubUpdateRun: { status },
    }),
  )
  expect(welcomed.hubUpdateRun).toEqual({ status })
  // Kept while the Hub restarts under it.
  const down = reduce(welcomed, {
    _tag: "ConnectionChanged",
    connection: { status: "reconnecting", attempt: 1 },
  })
  expect(down.hubUpdateRun).toEqual({ status })
  const ended = reduce(
    down,
    hub({
      _tag: "HubUpdateRunChanged",
      run: { status: { ...status, state: "RolledBack", error: "no" }, logTail: "== Rolling back" },
    }),
  )
  expect(ended.hubUpdateRun?.status.state).toBe("RolledBack")
  expect(ended.hubUpdateRun?.logTail).toBe("== Rolling back")
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
    variables: [
      { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true, needsValue: false },
    ],
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

  test("losing access to a Repo drops its Environment and Test builds, until it is sent again", () => {
    const lost = run(
      hub({ _tag: "EnvironmentState", repo: "acme/app", environment, versions }),
      hub({ _tag: "EnvironmentState", repo: "acme/other", environment: null, versions: [] }),
      hub({ _tag: "TestBuildStarted", requestId: "q-2", testBuild }),
      hub({ _tag: "RepoAccessLost", repo: "acme/app" }),
    )
    expect(Object.keys(lost.environments)).toEqual(["acme/other"])
    expect(lost.testBuilds).toEqual({})
    expect(lost.lostRepos).toEqual({ "acme/app": true })

    const back = reduce(
      lost,
      hub({ _tag: "EnvironmentState", repo: "acme/app", environment, versions }),
    )
    expect(back.lostRepos).toEqual({})
    expect(back.environments["acme/app"]?.environment?.version).toBe(2 as never)
  })

  test("a Repo's Environment and its loss are one, however its name is spelled (#197)", () => {
    const state = run(
      hub({ _tag: "EnvironmentState", repo: "Acme/App", environment, versions }),
      hub({ _tag: "EnvironmentState", repo: "acme/app", environment, versions }),
    )
    expect(Object.keys(state.environments)).toEqual(["acme/app"])

    const lost = run(
      hub({ _tag: "EnvironmentState", repo: "acme/app", environment, versions }),
      hub({ _tag: "TestBuildStarted", requestId: "q-2", testBuild }),
      hub({ _tag: "RepoAccessLost", repo: "ACME/app" }),
    )
    expect(lost.environments).toEqual({})
    expect(lost.testBuilds).toEqual({})
    expect(lost.lostRepos).toEqual({ "acme/app": true })
    const back = reduce(
      lost,
      hub({ _tag: "EnvironmentState", repo: "Acme/App", environment, versions }),
    )
    expect(back.lostRepos).toEqual({})
  })

  test("a Repo check is an answer for whoever asked", () => {
    const checked = hub({
      _tag: "RepoChecked",
      requestId: "q-4",
      repo: "acme/app",
      status: "NoAccess",
    })
    expect(reduce(initialState, checked)).toBe(initialState)
  })
})

describe("People (#209)", () => {
  const member = { participant: alice, owner: true, admittedAt: 1 }
  const invite = { id: "inv-1", createdBy: alice, createdAt: 1, expiresAt: 2 }

  test("MemberList and InviteList replace what was known; a new Invite's link isn't kept", () => {
    const state = run(
      hub({ _tag: "MemberList", members: [member] }),
      hub({ _tag: "InviteList", invites: [invite] }),
    )
    expect(state.members?.map((m) => m.participant.login)).toEqual([alice.login])
    expect(state.invites?.map((i) => i.id as string)).toEqual(["inv-1"])

    const created = hub({
      _tag: "InviteCreated",
      requestId: "q-1",
      id: "inv-2",
      link: "https://hub.example.com/invite#chi_inv-2.secret",
      expiresAt: 3,
    })
    expect(reduce(state, created)).toBe(state)
    expect(reduce(state, hub({ _tag: "InviteList", invites: [] })).invites).toEqual([])
  })
})

/** A step of the OpenAI sign-in `requestId` started, as the Hub sends it. */
const stepped = (step: SignInStepEncoded, requestId = "q-sign") =>
  hub({ _tag: "SignInStepped", requestId, provider: "openai", step })

/** The end of the OpenAI sign-in `requestId` started, as the Hub sends it. */
const ended = (
  outcome: "Connected" | "Failed" | "Cancelled",
  message?: string,
  requestId = "q-sign",
) =>
  hub({
    _tag: "SignInEnded",
    requestId,
    provider: "openai",
    outcome,
    ...(message !== undefined && { message }),
  })

describe("Connected providers (ADR 0029)", () => {
  const gpt = {
    provider: "openai",
    id: "gpt-6-sol",
    label: "GPT-6-Sol",
    thinkingLevels: ["low", "medium", "high"],
  } as const
  const providers = hub({
    _tag: "ProvidersState",
    claudeHarness: "ClaudeCode",
    connected: [
      {
        provider: "openai",
        kind: "SignIn",
        label: "alice@example.com",
        connectedAt: 1,
        models: [gpt],
        modelsCheckedAt: 2,
      },
    ],
    connectable: [
      { provider: "openai", name: "OpenAI", signIn: "Sign in with ChatGPT", apiKey: true },
      { provider: "xai", name: "xAI", signIn: "Sign in with SuperGrok or X Premium", apiKey: true },
    ],
    models: [gpt],
  })
  const started: HubAction = {
    _tag: "SignInStarted",
    requestId: RequestId.make("q-sign"),
    provider: "openai",
  }
  const openUrl = { _tag: "OpenUrl", url: "https://auth.openai.com/authorize?x=1" } as const
  const paste = { _tag: "Paste", message: "Paste the redirect URL" } as const
  const lost: HubAction = {
    _tag: "ConnectionChanged",
    connection: { status: "reconnecting", attempt: 1 },
  }

  test("ProvidersState is kept whole, answered or broadcast, in place of the last", () => {
    expect(initialState.providers).toBeNull()
    const state = run(providers)
    expect(state.providers?.connected.map((each) => each.label)).toEqual(["alice@example.com"])
    expect(state.providers?.connectable.map((each) => each.name)).toEqual(["OpenAI", "xAI"])
    expect(state.providers?.models.map((model) => model.id)).toEqual(["gpt-6-sol"])
    const none = reduce(
      state,
      hub({
        _tag: "ProvidersState",
        requestId: "q-1",
        connected: [],
        connectable: [],
        models: [],
        claudeHarness: "Pi",
      }),
    )
    // With which Harness runs Claude's Models in new Sessions (ADR 0030).
    expect(state.providers?.claudeHarness).toBe("ClaudeCode")
    expect(none.providers).toEqual({
      connected: [],
      connectable: [],
      models: [],
      claudeHarness: "Pi",
    })
  })

  test("a sign-in's steps go to the sign-in in progress, in order; another's are dropped", () => {
    expect(initialState.signIn).toBeNull()
    // Before any sign-in, a step is no one's.
    expect(reduce(initialState, stepped(openUrl))).toBe(initialState)
    const state = run(started, stepped(openUrl), stepped(paste), stepped(openUrl, "q-other"))
    expect(state.signIn?.provider).toBe("openai")
    expect(state.signIn?.steps.map((step) => step._tag)).toEqual(["OpenUrl", "Paste"])
    expect(state.signIn?.ended).toBeNull()
  })

  test("a sign-in ends connected, failed or cancelled, and a new one replaces it", () => {
    const failed = run(started, stepped(openUrl), ended("Failed", "The code expired."))
    expect(failed.signIn?.ended).toEqual({ outcome: "Failed", message: "The code expired." })
    // Its steps stay, so the page can say where it got to.
    expect(failed.signIn?.steps).toHaveLength(1)
    expect(reduce(failed, ended("Connected", undefined, "q-other"))).toBe(failed)
    expect(run(started, ended("Cancelled")).signIn?.ended).toEqual({ outcome: "Cancelled" })

    const again = reduce(failed, {
      _tag: "SignInStarted",
      requestId: RequestId.make("q-again"),
      provider: "xai",
    })
    expect(again.signIn).toEqual({
      requestId: RequestId.make("q-again"),
      provider: "xai",
      steps: [],
      ended: null,
    })
    expect(reduce(again, { _tag: "SignInCleared" }).signIn).toBeNull()
    // Clearing an older one leaves this one.
    expect(reduce(again, { _tag: "SignInCleared", requestId: RequestId.make("q-sign") })).toBe(
      again,
    )
  })

  test("a refusal of the sign-in, or a lost connection, ends it as failed", () => {
    const refused = run(
      started,
      hub({
        _tag: "CommandFailed",
        command: "StartSignIn",
        requestId: "q-sign",
        message: "OpenAI's sign-in isn't available.",
      }),
    )
    expect(refused.signIn?.ended).toEqual({
      outcome: "Failed",
      message: "OpenAI's sign-in isn't available.",
    })
    expect(run(started, stepped(openUrl), lost).signIn?.ended).toEqual({
      outcome: "Failed",
      message: "Lost the connection to the Hub. Sign in again.",
    })
    // One that already ended stays as it ended.
    const done = run(started, ended("Cancelled"))
    expect(reduce(done, lost).signIn).toBe(done.signIn)
  })

  test("a refused answer to the sign-in, or cancel of it, leaves it running, as the Hub does", () => {
    for (const command of ["AnswerSignIn", "CancelSignIn"]) {
      const refused = run(
        started,
        stepped(openUrl),
        hub({
          _tag: "CommandFailed",
          command,
          requestId: "q-sign",
          message: "This sign-in isn't waiting for an answer.",
        }),
      )
      expect(refused.signIn?.ended).toBeNull()
      expect(refused.signIn?.steps).toHaveLength(1)
    }
  })
})
