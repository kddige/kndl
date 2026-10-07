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
  runnerModels,
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
  { _tag: "AgentMessaged", agentId: "a-1", sender: alice, text: "also cover the edge cases" },
  { _tag: "SandboxNoted", message: "Memory capped at 8192 MiB by the Runner" },
  { _tag: "ModelSwitched", by: alice, model: "sonnet", modelLabel: "Sonnet 5.5", effort: "high" },
  { _tag: "ModelSwitched", by: bob, modelLabel: "Opus 5.5" },
  { _tag: "ModelSwitched", by: bob },
]

const webToHub = [
  { _tag: "WebHello", protocolVersion: ProtocolVersion },
  { _tag: "CreateSession", requestId: "q-1", repo: "kddige/kndl", baseBranch: "main" },
  {
    _tag: "CreateSession",
    requestId: "q-2",
    repo: "kddige/kndl",
    baseBranch: "main",
    runnerId: "r-1",
  },
  { _tag: "JoinSession", sessionId: "s-1" },
  { _tag: "JoinSession", sessionId: "s-1", afterSeq: 41 },
  { _tag: "LeaveSession", sessionId: "s-1" },
  { _tag: "SendPrompt", sessionId: "s-1", text: "add a health check" },
  { _tag: "CancelPrompt", sessionId: "s-1", promptId: "p-2" },
  { _tag: "SteerPrompt", sessionId: "s-1", promptId: "p-2" },
  { _tag: "StopTurn", sessionId: "s-1" },
  { _tag: "MessageAgent", sessionId: "s-1", agentId: "a-1", text: "also cover the edge cases" },
  { _tag: "StopAgent", sessionId: "s-1", agentId: "a-1" },
  {
    _tag: "AnswerQuestion",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    answer: { _tag: "Answered", answers: { "Which date library?": "date-fns" } },
  },
  {
    _tag: "AnswerQuestion",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    answer: { _tag: "Replied", text: "neither" },
  },
  {
    _tag: "AnswerQuestion",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    answer: { _tag: "Dismissed" },
  },
  {
    _tag: "PickAnswer",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    question: "Which date library?",
    answer: "Temporal",
  },
  { _tag: "PickAnswer", sessionId: "s-1", toolCallId: "toolu_ask", question: "Q?", answer: "" },
  { _tag: "SleepSession", sessionId: "s-1" },
  { _tag: "WakeSession", sessionId: "s-1" },
  { _tag: "SetKeepAwake", sessionId: "s-1", on: true },
  { _tag: "SetKeepAwake", sessionId: "s-1", on: false },
  { _tag: "RestartSession", sessionId: "s-1" },
  { _tag: "ArchiveSession", sessionId: "s-1" },
  { _tag: "RestoreSession", sessionId: "s-1" },
  { _tag: "RenameSession", sessionId: "s-1", name: "Health check" },
  { _tag: "RenameSession", sessionId: "s-1", name: "" },
  { _tag: "OpenTerminal", sessionId: "s-1" },
  { _tag: "CloseTerminal", sessionId: "s-1" },
  { _tag: "TerminalInput", sessionId: "s-1", data: "\u001b[A" },
  { _tag: "TerminalResize", sessionId: "s-1", size },
  { _tag: "GetEnvironment", requestId: "q-3", repo: "kddige/kndl" },
  {
    _tag: "CheckEnvironmentDraft",
    requestId: "q-4",
    repo: "kddige/kndl",
    draft: environmentDraft,
  },
  {
    _tag: "StartTestBuild",
    requestId: "q-5",
    repo: "kddige/kndl",
    runnerId: "r-1",
    draft: environmentDraft,
  },
  {
    _tag: "ApplyEnvironment",
    requestId: "q-6",
    repo: "kddige/kndl",
    baseVersion: 2,
    draft: environmentDraft,
  },
  {
    _tag: "ApplyEnvironment",
    requestId: "q-7",
    repo: "kddige/kndl",
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
  { _tag: "CheckRepo", requestId: "q-13", repo: "kddige/kndl" },
  { _tag: "CheckRepo", requestId: "q-14", repo: "kddige/kndl", fresh: true },
  { _tag: "CreatePairingCode", requestId: "q-13" },
  { _tag: "CreatePairingCode", requestId: "q-14", runnerId: "r-1" },
  { _tag: "RevokePairingCode", requestId: "q-15", pairingCodeId: "pc-1" },
  { _tag: "RemoveRunner", requestId: "q-16", runnerId: "r-1" },
  { _tag: "UpdateRunner", requestId: "q-17", runnerId: "r-1", now: false },
  {
    _tag: "CreateSession",
    requestId: "q-18",
    repo: "kddige/kndl",
    baseBranch: "main",
    model: "opus[1m]",
    effort: "low",
  },
  { _tag: "SetSessionModel", sessionId: "s-1", model: "sonnet", effort: "xhigh" },
  { _tag: "SetSessionModel", sessionId: "s-1", model: "claude-sonnet-4-5" },
  {
    _tag: "SetClaudeCredential",
    requestId: "q-19",
    secret: "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY",
    plan: "max5x",
  },
  {
    _tag: "SetClaudeCredential",
    requestId: "q-20",
    secret: "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY",
  },
  { _tag: "RemoveClaudeCredential", requestId: "q-21" },
  { _tag: "SetSessionModel", sessionId: "s-1" },
  { _tag: "RevokeCliToken", requestId: "q-22", cliTokenId: "ct-1" },
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
        updater: { self: true },
        update: {
          _tag: "Draining",
          target: { commit: "a".repeat(40), branch: "main" },
          since: 1_790_000_000_000,
          deadline: 1_790_000_600_000,
          now: false,
          waitingFor: 1,
        },
      },
      {
        id: "r-3",
        name: "laptop",
        login: runnerLogin,
        isOnline: true,
        version: { commit: "b".repeat(40) },
        versionStatus: "Behind",
        lastSeenAt: 1_790_000_000_000,
        openSessions: 0,
        updater: { self: false, reason: "It runs from a developer's checkout" },
        update: {
          _tag: "Refused",
          target: { commit: "a".repeat(40) },
          at: 1_790_000_000_000,
          refusal: { reason: "NotOnMain", message: "Not reachable from origin/main" },
        },
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
  {
    _tag: "SessionUpdated",
    session: {
      ...sessionSummary,
      currentTurn: null,
      agents: [
        { id: "a-1", description: "Survey the docs", status: "Running" },
        { id: "a-2", description: "Fix the flaky test", status: "Interrupted" },
      ],
    },
  },
  {
    _tag: "SessionUpdated",
    session: { ...sessionSummary, model: "sonnet", effort: "high", modelPending: true },
  },
  {
    _tag: "SessionUpdated",
    session: { ...sessionSummary, keepAwake: { by: bob, at: 1_790_000_000_000 } },
  },
  {
    _tag: "SessionUpdated",
    session: {
      ...sessionSummary,
      currentTurn: "t-1",
      openQuestion: {
        turnId: "t-1",
        toolCallId: "toolu_ask",
        questions: [
          {
            question: "Which date library?",
            header: "Library",
            options: [{ label: "date-fns", description: "Small" }, { label: "Temporal" }],
            multiSelect: false,
          },
        ],
        askedAt: 1_790_000_000_000,
      },
    },
  },
  {
    _tag: "QuestionPicks",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    picks: [{ participant: bob, question: "Which date library?", answer: "Temporal" }],
  },
  { _tag: "QuestionPicks", sessionId: "s-1", toolCallId: "toolu_ask", picks: [] },
  {
    _tag: "RunnerList",
    runners: [
      {
        id: "r-1",
        name: "studio",
        login: runnerLogin,
        isOnline: true,
        version: null,
        versionStatus: "Unknown",
        lastSeenAt: 1_790_000_000_000,
        openSessions: 1,
        models: runnerModels,
      },
    ],
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
    repo: "kddige/kndl",
    environment,
    versions: [
      { version: 3, appliedBy: alice, appliedAt: 1_790_000_000_300, rebuilt: false },
      { version: 2, appliedBy: bob, appliedAt: 1_790_000_000_200, rebuilt: true },
    ],
  },
  { _tag: "EnvironmentState", repo: "kddige/kndl", environment: null, versions: [] },
  {
    _tag: "EnvironmentDraftChecked",
    requestId: "q-4",
    repo: "kddige/kndl",
    needsTestBuild: true,
    testBuildPassed: false,
  },
  {
    _tag: "TestBuildStarted",
    requestId: "q-5",
    testBuild: {
      id: "b-1",
      repo: "kddige/kndl",
      runnerId: "r-1",
      startedBy: alice,
      startedAt: 1_790_000_000_000,
    },
  },
  { _tag: "TestBuildLogged", testBuildId: "b-1", data: "Setting up ripgrep\n" },
  { _tag: "TestBuildEnded", testBuildId: "b-1", repo: "kddige/kndl", result: "Passed" },
  {
    _tag: "TestBuildEnded",
    testBuildId: "b-1",
    repo: "kddige/kndl",
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
        linkedBy: [{ repo: "kddige/kndl", name: "GH_TOKEN", availableAtBuild: false }],
        needsValue: false,
      },
      { _tag: "Sensitive", name: "NPM_TOKEN", linkedBy: [], needsValue: true },
    ],
  },
  { _tag: "SharedVariables", variables: [] },
  { _tag: "ClaudeCredentialState", credential: null },
  {
    _tag: "ClaudeCredentialState",
    requestId: "q-19",
    credential: { kind: "OAuthToken", last4: "ONLY", plan: "max5x", addedAt: 1_700_000_000_000 },
    warning: "Saved without checking it: Anthropic couldn't be reached.",
  },
  { _tag: "RepoChecked", requestId: "q-13", repo: "kddige/kndl", status: "Allowed" },
  { _tag: "RepoChecked", requestId: "q-13", repo: "kddige/kndl", status: "NoAccess" },
  {
    _tag: "RepoChecked",
    requestId: "q-14",
    repo: "kddige/kndl",
    status: "NotInstalled",
    installUrl: "https://github.com/apps/kndl-ada/installations/new",
  },
  { _tag: "RepoAccessLost", repo: "kddige/kndl" },
  {
    _tag: "AppPermissionsChecked",
    requestId: "q-12",
    check: {
      slug: "kndl-ada",
      settingsUrl: "https://github.com/settings/apps/kndl-ada/permissions",
      installUrl: "https://github.com/apps/kndl-ada/installations/new",
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
  { _tag: "PairingCodeRedeemed", id: "pc-1", runnerId: "r-1", name: "studio", repaired: true },
  { _tag: "RunnerUpdateRequested", requestId: "q-17", runnerId: "r-1" },
  { _tag: "CliTokenList", tokens: [] },
  {
    _tag: "CliTokenList",
    requestId: "q-22",
    tokens: [
      {
        id: "ct-1",
        machine: "laptop",
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_060_000,
      },
      { id: "ct-2", machine: "build-box", createdAt: 1_700_000_000_000 },
    ],
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
    expectRejected(WebToHub, { _tag: "SleepSession" })
    expectRejected(WebToHub, {
      _tag: "AnswerQuestion",
      sessionId: "s-1",
      toolCallId: "toolu_ask",
      answer: { _tag: "Cancelled" },
    })
    expectRejected(WebToHub, {
      _tag: "AnswerQuestion",
      sessionId: "s-1",
      answer: { _tag: "Dismissed" },
    })
    expectRejected(WebToHub, { _tag: "WakeSession", sessionId: 7 })
    expectRejected(WebToHub, {
      _tag: "CreateSession",
      repo: "kddige/kndl",
      baseBranch: "main",
    })
    expectRejected(WebToHub, { ...webToHub[1], repo: "kddige/kndl/extra" })
    expectRejected(WebToHub, { _tag: "JoinSession", sessionId: "s-1", afterSeq: -1 })
    expectRejected(WebToHub, { _tag: "CancelPrompt", sessionId: "s-1" })
    expectRejected(WebToHub, { _tag: "SteerPrompt", sessionId: "s-1" })
    expectRejected(WebToHub, { _tag: "DeliverPrompt", sessionId: "s-1", promptId: "p", text: "x" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", model: "" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", model: "-p" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", model: "x".repeat(201) })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", effort: "extra" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", effort: "auto" })
    expectRejected(WebToHub, { ...webToHub[1], model: "son net" })
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
