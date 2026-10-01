import { describe, test } from "bun:test"
import {
  alice,
  bob,
  expectEveryTag,
  expectRejected,
  expectRoundTrips,
  runnerLogin,
  sessionSummary,
  turnEvents,
} from "./testSupport.ts"
import { ProtocolVersion } from "./Version.ts"
import { HubToWeb, SessionEvent, WebToHub } from "./Web.ts"

const size = { cols: 120, rows: 40 }

const sessionEvents = [
  ...turnEvents,
  { _tag: "SessionStateChanged", state: "Active" },
  { _tag: "SessionStateChanged", state: "Frozen", message: "Runner studio is offline" },
  { _tag: "SessionStateChanged", state: "Archived", by: bob },
  { _tag: "TurnStopRequested", by: alice },
]

const webToHub = [
  { _tag: "WebHello", protocolVersion: ProtocolVersion },
  { _tag: "CreateSession", requestId: "q-1", repo: "kddige/claude-hub", baseBranch: "main" },
  {
    _tag: "CreateSession",
    requestId: "q-2",
    repo: "kddige/claude-hub",
    baseBranch: "main",
    runnerId: "r-1",
  },
  { _tag: "JoinSession", sessionId: "s-1" },
  { _tag: "JoinSession", sessionId: "s-1", afterSeq: 41 },
  { _tag: "LeaveSession", sessionId: "s-1" },
  { _tag: "SendPrompt", sessionId: "s-1", text: "add a health check" },
  { _tag: "CancelPrompt", sessionId: "s-1", promptId: "p-2" },
  { _tag: "StopTurn", sessionId: "s-1" },
  { _tag: "OpenTerminal", sessionId: "s-1" },
  { _tag: "CloseTerminal", sessionId: "s-1" },
  { _tag: "TerminalInput", sessionId: "s-1", data: "\u001b[A" },
  { _tag: "TerminalResize", sessionId: "s-1", size },
]

const hubToWeb = [
  { _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice },
  {
    _tag: "HandshakeRejected",
    reason: "ProtocolVersionMismatch",
    protocolVersion: ProtocolVersion,
    message: "reload the page",
  },
  {
    _tag: "RunnerList",
    runners: [{ id: "r-1", name: "studio", login: runnerLogin, isOnline: true }],
  },
  { _tag: "SessionList", sessions: [sessionSummary] },
  { _tag: "SessionList", sessions: [] },
  { _tag: "SessionUpdated", session: { ...sessionSummary, state: "Asleep" } },
  { _tag: "SessionUpdated", session: { ...sessionSummary, currentTurn: "t-1" } },
  { _tag: "SessionCreated", requestId: "q-1", session: sessionSummary },
  {
    _tag: "SessionHistory",
    sessionId: "s-1",
    entries: sessionEvents.map((event, seq) => ({ seq, at: 1_790_000_000_000 + seq, event })),
  },
  {
    _tag: "SessionEventLogged",
    sessionId: "s-1",
    entry: { seq: 42, at: 1_790_000_000_042, event: turnEvents[2] },
  },
  { _tag: "PresenceChanged", sessionId: "s-1", participants: [alice, bob] },
  {
    _tag: "PromptQueueChanged",
    sessionId: "s-1",
    queue: [
      { id: "p-2", text: "then run the tests", sender: bob, queuedAt: 1_790_000_000_100 },
      { id: "p-3", text: "and commit", sender: alice, queuedAt: 1_790_000_000_200 },
    ],
  },
  { _tag: "TerminalFrame", sessionId: "s-1", kind: "Snapshot", data: "> ready", size },
  {
    _tag: "CommandFailed",
    command: "SendPrompt",
    sessionId: "s-1",
    message: "This Session is Frozen: its Runner is offline.",
  },
  {
    _tag: "CommandFailed",
    command: "CreateSession",
    requestId: "q-1",
    message: "No Runner online",
  },
]

describe("SessionEvent", () => {
  test("round-trips every kind of event", () => {
    expectEveryTag(SessionEvent, sessionEvents)
    expectRoundTrips(SessionEvent, sessionEvents)
  })

  test("rejects malformed events", () => {
    expectRejected(SessionEvent, { _tag: "SessionStateChanged", state: "Paused" })
    expectRejected(SessionEvent, { _tag: "TurnStopRequested" })
  })
})

describe("WebToHub", () => {
  test("round-trips every message", () => {
    expectEveryTag(WebToHub, webToHub)
    expectRoundTrips(WebToHub, webToHub)
  })

  test("rejects malformed messages", () => {
    expectRejected(WebToHub, { _tag: "SendPrompt", sessionId: "s-1", text: "" })
    expectRejected(WebToHub, { _tag: "SendPrompt", text: "hi" })
    expectRejected(WebToHub, {
      _tag: "CreateSession",
      repo: "kddige/claude-hub",
      baseBranch: "main",
    })
    expectRejected(WebToHub, { ...webToHub[1], repo: "kddige/claude-hub/extra" })
    expectRejected(WebToHub, { _tag: "JoinSession", sessionId: "s-1", afterSeq: -1 })
    expectRejected(WebToHub, { _tag: "CancelPrompt", sessionId: "s-1" })
    expectRejected(WebToHub, { _tag: "DeliverPrompt", sessionId: "s-1", promptId: "p", text: "x" })
  })
})

describe("HubToWeb", () => {
  test("round-trips every message", () => {
    expectEveryTag(HubToWeb, hubToWeb)
    expectRoundTrips(HubToWeb, hubToWeb)
  })

  test("rejects malformed messages", () => {
    expectRejected(HubToWeb, {
      _tag: "SessionUpdated",
      session: { ...sessionSummary, state: "Paused" },
    })
    expectRejected(HubToWeb, {
      _tag: "SessionUpdated",
      session: { ...sessionSummary, creator: null },
    })
    const { currentTurn: _, ...withoutTurn } = sessionSummary
    expectRejected(HubToWeb, { _tag: "SessionUpdated", session: withoutTurn })
    expectRejected(HubToWeb, {
      _tag: "SessionEventLogged",
      sessionId: "s-1",
      entry: { seq: 1.5, at: 0, event: turnEvents[2] },
    })
    expectRejected(HubToWeb, {
      _tag: "SessionEventLogged",
      sessionId: "s-1",
      entry: { seq: 1, at: 0, event: { _tag: "Chat", text: "hi" } },
    })
    expectRejected(HubToWeb, {
      _tag: "PromptQueueChanged",
      sessionId: "s-1",
      queue: [{ id: "p-2", text: "x", sender: bob }],
    })
    expectRejected(HubToWeb, { _tag: "RunnerList", runners: [{ id: "r-1", name: "studio" }] })
  })
})
