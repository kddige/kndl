import { describe, test } from "bun:test"
import {
  alice,
  bob,
  environment,
  environmentDraft,
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
  {
    _tag: "SessionStateChanged",
    state: "Asleep",
    message: "Claude Code could not start: API_KEY needs a value",
  },
  { _tag: "TurnStopRequested", by: alice },
  { _tag: "WipNotPushed", message: "git push exited with 128: could not read from remote" },
  { _tag: "SandboxNoted", message: "Memory capped at 8192 MiB by the Runner" },
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
  { _tag: "SleepSession", sessionId: "s-1" },
  { _tag: "WakeSession", sessionId: "s-1" },
  { _tag: "RestartSession", sessionId: "s-1" },
  { _tag: "ArchiveSession", sessionId: "s-1" },
  { _tag: "RestoreSession", sessionId: "s-1" },
  { _tag: "OpenTerminal", sessionId: "s-1" },
  { _tag: "CloseTerminal", sessionId: "s-1" },
  { _tag: "TerminalInput", sessionId: "s-1", data: "\u001b[A" },
  { _tag: "TerminalResize", sessionId: "s-1", size },
  { _tag: "GetEnvironment", requestId: "q-3", repo: "kddige/claude-hub" },
  {
    _tag: "CheckEnvironmentDraft",
    requestId: "q-4",
    repo: "kddige/claude-hub",
    draft: environmentDraft,
  },
  {
    _tag: "StartTestBuild",
    requestId: "q-5",
    repo: "kddige/claude-hub",
    runnerId: "r-1",
    draft: environmentDraft,
  },
  {
    _tag: "ApplyEnvironment",
    requestId: "q-6",
    repo: "kddige/claude-hub",
    baseVersion: 2,
    draft: environmentDraft,
  },
  {
    _tag: "ApplyEnvironment",
    requestId: "q-7",
    repo: "kddige/claude-hub",
    baseVersion: null,
    draft: { ...environmentDraft, variables: [] },
  },
  { _tag: "GetSharedVariables", requestId: "q-8" },
  {
    _tag: "SetSharedVariable",
    requestId: "q-9",
    variable: { _tag: "Plain", name: "REGISTRY", value: "ghcr.io" },
  },
  {
    _tag: "SetSharedVariable",
    requestId: "q-10",
    variable: {
      _tag: "Sensitive",
      name: "GITHUB_TOKEN",
      value: "ghp_secret",
    },
  },
  { _tag: "DeleteSharedVariable", requestId: "q-11", name: "REGISTRY" },
  { _tag: "CheckAppPermissions", requestId: "q-12" },
  { _tag: "CreatePairingCode", requestId: "q-13" },
  { _tag: "CreatePairingCode", requestId: "q-14", runnerId: "r-1" },
  { _tag: "RevokePairingCode", requestId: "q-15", pairingCodeId: "pc-1" },
  { _tag: "RemoveRunner", requestId: "q-16", runnerId: "r-1" },
]

const hubToWeb = [
  { _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice },
  {
    _tag: "WebWelcome",
    protocolVersion: ProtocolVersion,
    you: alice,
    hub: { commit: "a".repeat(40), branch: "main" },
  },
  {
    _tag: "HandshakeRejected",
    reason: "ProtocolVersionMismatch",
    protocolVersion: ProtocolVersion,
    message: "reload the page",
  },
  {
    _tag: "RunnerList",
    runners: [
      {
        id: "r-1",
        name: "studio",
        login: runnerLogin,
        isOnline: true,
        version: { commit: "b".repeat(40) },
        versionStatus: "Behind",
        lastSeenAt: 1_790_000_000_000,
        openSessions: 2,
      },
      {
        id: "r-2",
        name: "new-mac",
        login: null,
        isOnline: false,
        version: null,
        versionStatus: "Unknown",
        lastSeenAt: null,
        openSessions: 0,
      },
    ],
  },
  { _tag: "SessionList", sessions: [sessionSummary] },
  { _tag: "SessionList", sessions: [] },
  { _tag: "SessionUpdated", session: { ...sessionSummary, state: "Asleep" } },
  { _tag: "SessionUpdated", session: { ...sessionSummary, currentTurn: "t-1" } },
  {
    _tag: "SessionUpdated",
    session: {
      ...sessionSummary,
      state: "Archived",
      archived: { by: bob, at: 1_790_000_000_000, purgeAt: 1_792_592_000_000 },
    },
  },
  { _tag: "SessionRemoved", sessionId: "s-1" },
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
  {
    _tag: "SessionUpdated",
    session: { ...sessionSummary, environment: { version: 2, latestVersion: 3 } },
  },
  {
    _tag: "SessionUpdated",
    session: { ...sessionSummary, environment: { version: null, latestVersion: 1 } },
  },
  {
    _tag: "SessionUpdated",
    session: {
      ...sessionSummary,
      environment: { version: null, latestVersion: 1 },
      starting: { since: 1_790_000_000_000, environmentVersion: 1 },
      restarting: { by: bob, since: 1_789_999_990_000 },
    },
  },
  {
    _tag: "SessionUpdated",
    session: { ...sessionSummary, starting: { since: 1_790_000_000_000 } },
  },
  { _tag: "SessionStartLogged", sessionId: "s-1", since: 1_790_000_000_000, data: "Step 1/3\r\n" },
  {
    _tag: "SessionStartLogged",
    sessionId: "s-1",
    since: 1_790_000_000_000,
    data: "Step 1/3\r\nStep 2/3\r\n",
    replace: true,
  },
  {
    _tag: "EnvironmentState",
    requestId: "q-3",
    repo: "kddige/claude-hub",
    environment,
    versions: [
      { version: 3, appliedBy: alice, appliedAt: 1_790_000_000_300, rebuilt: false },
      { version: 2, appliedBy: bob, appliedAt: 1_790_000_000_200, rebuilt: true },
    ],
  },
  { _tag: "EnvironmentState", repo: "kddige/claude-hub", environment: null, versions: [] },
  {
    _tag: "EnvironmentDraftChecked",
    requestId: "q-4",
    repo: "kddige/claude-hub",
    needsTestBuild: true,
    testBuildPassed: false,
  },
  {
    _tag: "TestBuildStarted",
    requestId: "q-5",
    testBuild: {
      id: "b-1",
      repo: "kddige/claude-hub",
      runnerId: "r-1",
      startedBy: alice,
      startedAt: 1_790_000_000_000,
    },
  },
  { _tag: "TestBuildLogged", testBuildId: "b-1", data: "Setting up ripgrep\n" },
  { _tag: "TestBuildEnded", testBuildId: "b-1", repo: "kddige/claude-hub", result: "Passed" },
  {
    _tag: "TestBuildEnded",
    testBuildId: "b-1",
    repo: "kddige/claude-hub",
    result: "Failed",
    message: "The bootstrap exited with 100",
  },
  {
    _tag: "SharedVariables",
    requestId: "q-8",
    variables: [
      { _tag: "Plain", name: "REGISTRY", value: "ghcr.io", linkedBy: [] },
      {
        _tag: "Sensitive",
        name: "GITHUB_TOKEN",
        linkedBy: [{ repo: "kddige/claude-hub", name: "GH_TOKEN", availableAtBuild: false }],
        needsValue: false,
      },
      { _tag: "Sensitive", name: "NPM_TOKEN", linkedBy: [], needsValue: true },
    ],
  },
  { _tag: "SharedVariables", variables: [] },
  {
    _tag: "AppPermissionsChecked",
    requestId: "q-12",
    check: {
      slug: "claude-hub-ada",
      settingsUrl: "https://github.com/settings/apps/claude-hub-ada/permissions",
      installUrl: "https://github.com/apps/claude-hub-ada/installations/new",
      missing: [{ name: "issues", title: "Issues", access: "write" }],
      missingEvents: [],
      installed: 2,
      installations: [
        {
          id: 7,
          account: "ada",
          reviewUrl: "https://github.com/settings/installations/7/permissions/update",
          missing: [{ name: "pull_requests", title: "Pull requests", access: "write" }],
          missingEvents: [],
        },
      ],
      checkedAt: 1_700_000_000_000,
    },
  },
  {
    _tag: "PairingCodeCreated",
    requestId: "q-13",
    id: "pc-1",
    code: "7K3QH-WM2PA-9XC4R-TBV0E",
    link: "https://hub.example.com#7K3QH-WM2PA-9XC4R-TBV0E",
    expiresAt: 1_790_000_900_000,
  },
  {
    _tag: "PairingCodeList",
    requestId: "q-15",
    codes: [
      {
        id: "pc-2",
        runnerId: "r-1",
        createdBy: alice,
        createdAt: 1_790_000_000_000,
        expiresAt: 1_790_000_900_000,
      },
    ],
  },
  { _tag: "PairingCodeList", codes: [] },
  { _tag: "RunnerRemoved", requestId: "q-16", runnerId: "r-1" },
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
    expectRejected(WebToHub, { _tag: "SleepSession" })
    expectRejected(WebToHub, { _tag: "WakeSession", sessionId: 7 })
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
