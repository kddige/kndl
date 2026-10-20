import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  alice,
  bob,
  environment,
  environmentDraft,
  expectEveryTag,
  expectRejected,
  expectRoundTrips,
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
  {
    _tag: "AgentMessaged",
    agentId: "a-1",
    sender: alice,
    text: "",
    attachments: [{ id: "att-1", name: "shot.png", mediaType: "image/png", size: 12 }],
  },
  { _tag: "SandboxNoted", message: "Memory capped at 8192 MiB by the Runner" },
  {
    _tag: "ModelSwitched",
    by: alice,
    model: "sonnet",
    modelLabel: "Sonnet 5.5",
    thinkingLevel: "high",
  },
  { _tag: "ModelSwitched", by: bob, modelLabel: "Opus 5.5" },
  {
    _tag: "ModelSwitched",
    by: alice,
    model: "openai/gpt-6-sol",
    modelLabel: "GPT-6-Sol",
    harness: "Pi",
  },
  { _tag: "ModelSwitched", by: bob },
  {
    _tag: "PromptCancelled",
    promptId: "p-1",
    sender: bob,
    text: "fix the tests",
    message: "Only the Creator prompts a Session now",
  },
  { _tag: "TurnStopRequested", by: bob, threadId: "thr-1" },
  {
    _tag: "ThreadStarted",
    threadId: "thr-1",
    anchorTurnId: "t-1",
    title: "what about Windows?",
    startedBy: bob,
    model: "openai/gpt-6-luna",
  },
  {
    _tag: "ThreadPromptSent",
    threadId: "thr-1",
    promptId: "p-7",
    requestId: "q-70",
    sender: bob,
    text: "what about Windows?",
  },
  { _tag: "ThreadPromptSent", threadId: "thr-1", promptId: "p-9", sender: bob, text: "more" },
  { _tag: "ThreadPromptFailed", threadId: "thr-1", promptId: "p-9", message: "storage is full" },
  {
    _tag: "ThreadPromptFailed",
    threadId: "thr-2",
    promptId: "p-10",
    message: "The main loop has nothing to fork a thread from yet.",
    threadDropped: true,
  },
  {
    _tag: "ThreadModelChanged",
    threadId: "thr-1",
    by: alice,
    model: "openai/gpt-6-sol",
    thinkingLevel: "high",
  },
]

const webToHub = [
  { _tag: "WebHello", protocolVersion: ProtocolVersion },
  {
    _tag: "CreateSession",
    requestId: "q-1",
    repo: "kddige/kndl",
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  },
  {
    _tag: "CreateSession",
    requestId: "q-2",
    repo: "kddige/kndl",
    branch: { _tag: "Existing", name: "main", newWorkBranch: false },
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
  { _tag: "MessageAgent", sessionId: "s-1", agentId: "a-1", text: "", attachments: ["att-1"] },
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
    answer: { _tag: "Replied", text: "like this" },
    attachments: ["att-1"],
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
  { _tag: "PurgeArchivedSession", requestId: "q-0", sessionId: "s-1" },
  { _tag: "GetSessionDiskUsage", requestId: "q-0", sessionIds: ["s-1", "s-2"] },
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
  { _tag: "CheckHubUpdate", requestId: "q-12b" },
  { _tag: "UpdateHub", requestId: "q-12c", now: false },
  { _tag: "UpdateHub", requestId: "q-12d", now: true, channel: "dev" },
  { _tag: "CheckRepo", requestId: "q-13", repo: "kddige/kndl" },
  { _tag: "CheckRepo", requestId: "q-14", repo: "kddige/kndl", fresh: true },
  { _tag: "ListRepos", requestId: "q-14" },
  { _tag: "ListBranches", requestId: "q-14", repo: "kddige/kndl" },
  { _tag: "CreatePairingCode", requestId: "q-13" },
  { _tag: "CreatePairingCode", requestId: "q-14", runnerId: "r-1" },
  { _tag: "RevokePairingCode", requestId: "q-15", pairingCodeId: "pc-1" },
  { _tag: "RemoveRunner", requestId: "q-16", runnerId: "r-1" },
  { _tag: "UpdateRunner", requestId: "q-17", runnerId: "r-1", now: false },
  { _tag: "GetRunnerHistory", requestId: "q-18", runnerId: "r-1" },
  {
    _tag: "CreateSession",
    requestId: "q-18",
    repo: "kddige/kndl",
    branch: { _tag: "Create", name: "feature/health-check", from: "main" },
    model: "opus[1m]",
    thinkingLevel: "low",
  },
  { _tag: "SetSessionModel", sessionId: "s-1", model: "sonnet", thinkingLevel: "xhigh" },
  { _tag: "SetSessionModel", sessionId: "s-1", model: "claude-sonnet-4-5" },
  {
    _tag: "SetClaudeCredential",
    requestId: "q-19",
    secret: "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY",
  },
  {
    _tag: "SetClaudeCredential",
    requestId: "q-20",
    secret: "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY",
  },
  { _tag: "RemoveClaudeCredential", requestId: "q-21" },
  { _tag: "GetProviders", requestId: "q-40" },
  { _tag: "ConnectProviderKey", requestId: "q-41", provider: "xai", apiKey: "xai-FAKE_KEY" },
  { _tag: "StartSignIn", requestId: "q-42", provider: "openai" },
  { _tag: "AnswerSignIn", requestId: "q-42", value: "http://127.0.0.1:1455/auth/callback?code=c" },
  { _tag: "CancelSignIn", requestId: "q-42" },
  { _tag: "DisconnectProvider", requestId: "q-43", provider: "openai" },
  { _tag: "RefreshProviderModels", requestId: "q-44" },
  { _tag: "RefreshProviderModels", requestId: "q-45", provider: "xai" },
  {
    _tag: "CreateSession",
    requestId: "q-46",
    repo: "kddige/kndl",
    branch: { _tag: "Create", name: "feature/pi", from: "main" },
    model: "openai/gpt-6-sol",
    thinkingLevel: "minimal",
  },
  { _tag: "SetSessionModel", sessionId: "s-1" },
  { _tag: "RevokeCliToken", requestId: "q-22", cliTokenId: "ct-1" },
  { _tag: "CreateInvite", requestId: "q-23" },
  { _tag: "CreateInvite", requestId: "q-24", login: "Octo-Cat" },
  { _tag: "ListInvites", requestId: "q-25" },
  { _tag: "RevokeInvite", requestId: "q-26", inviteId: "inv-1" },
  { _tag: "ListMembers", requestId: "q-27" },
  { _tag: "RemoveMember", requestId: "q-28", participantId: "u-2" },
  { _tag: "GetMcpServers", requestId: "q-29" },
  {
    _tag: "CreateMcpServer",
    requestId: "q-30",
    name: "Docs search",
    url: "https://mcp.example.com/mcp",
    auth: { _tag: "None" },
  },
  {
    _tag: "EditMcpServer",
    requestId: "q-31",
    mcpServerId: "hub:docs-search",
    name: "Docs",
    url: "https://mcp.example.com/v2",
    auth: {
      _tag: "Headers",
      headers: [
        { key: "token", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    },
  },
  { _tag: "DeleteMcpServer", requestId: "q-32", mcpServerId: "hub:docs-search" },
  {
    _tag: "CreateInstallation",
    requestId: "q-33",
    mcpServerId: "hub:docs-search",
    name: "Docs",
    repos: ["kddige/kndl"],
    values: [{ key: "token", value: "sk-live-0123" }],
  },
  {
    _tag: "EditInstallation",
    requestId: "q-34",
    installationId: "in-1",
    name: "Docs",
    repos: ["kddige/kndl", "kddige/dotfiles"],
  },
  { _tag: "DeleteInstallation", requestId: "q-35", installationId: "in-1" },
  { _tag: "ConnectInstallation", requestId: "q-35a", installationId: "in-2" },
  {
    _tag: "ConnectInstallation",
    requestId: "q-35c",
    installationId: "in-2",
    client: { clientId: "Iv1.0a1b2c", clientSecret: "gh-secret-0123" },
  },
  { _tag: "ConnectInstallation", requestId: "q-35d", installationId: "in-2", changeClient: true },
  { _tag: "DisconnectInstallation", requestId: "q-35b", installationId: "in-2" },
  { _tag: "GetMcpServerLog", requestId: "q-36", repo: "kddige/kndl" },
  {
    _tag: "CreateInstallation",
    requestId: "q-43",
    mcpServerId: "hub:docs-search",
    name: "Docs",
    global: true,
    repos: [],
  },
  {
    _tag: "TurnGlobalInstallation",
    requestId: "q-44",
    installationId: "in-1",
    repo: "kddige/kndl",
    on: false,
  },
  {
    _tag: "ReadMcpServerPackage",
    requestId: "q-37",
    from: {
      _tag: "Git",
      url: "https://github.com/acme/linear-mcp.git",
      ref: "v1.2.0",
      path: "packages/linear",
    },
  },
  {
    _tag: "ReadMcpServerPackage",
    requestId: "q-38",
    from: { _tag: "Archive", fileName: "linear-mcp-1.2.0.tgz", data: "H4sIAAAAAAAAAw==" },
  },
  {
    _tag: "ReadMcpServerPackage",
    requestId: "q-39",
    from: {
      _tag: "Folder",
      folderName: "linear-mcp",
      packageJson: '{"name":"linear-mcp","version":"1.2.0"}',
      manifest: '{"displayName":"Linear","mcp":{"url":"https://mcp.linear.app/mcp"}}',
    },
  },
  { _tag: "CheckMcpServerUpgrade", requestId: "q-40", mcpServerId: "@acme/linear-mcp" },
  { _tag: "AddMcpServerPackage", requestId: "q-41", readId: "read-1" },
  {
    _tag: "UpgradeMcpServer",
    requestId: "q-42",
    mcpServerId: "@acme/linear-mcp",
    readId: "read-2",
  },
  {
    _tag: "CreateThread",
    requestId: "q-43",
    sessionId: "s-1",
    anchorTurnId: "t-1",
    text: "what about Windows?",
    model: "openai/gpt-6-luna",
  },
  {
    _tag: "CreateThread",
    requestId: "q-44",
    sessionId: "s-1",
    anchorTurnId: "t-1",
    text: "",
    attachments: ["att-1"],
  },
  {
    _tag: "PromptThread",
    requestId: "q-45",
    sessionId: "s-1",
    threadId: "thr-1",
    text: "and macOS",
  },
  { _tag: "StopThread", sessionId: "s-1", threadId: "thr-1" },
  {
    _tag: "SetThreadModel",
    sessionId: "s-1",
    threadId: "thr-1",
    model: "openai/gpt-6-sol",
    thinkingLevel: "high",
  },
  { _tag: "CompactConversation", sessionId: "s-1" },
  {
    _tag: "CompactConversation",
    sessionId: "s-1",
    threadId: "thr-1",
    instructions: "Keep the test names",
  },
]

const hubToWeb = [
  { _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice },
  { _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: alice, owner: true },
  {
    _tag: "WebWelcome",
    protocolVersion: ProtocolVersion,
    you: alice,
    hub: { commit: "a".repeat(40), branch: "main" },
  },
  {
    _tag: "WebWelcome",
    protocolVersion: ProtocolVersion,
    you: alice,
    owner: true,
    hubUpdate: { follows: { _tag: "Pinned", ref: "fix-login" } },
  },
  {
    _tag: "WebWelcome",
    protocolVersion: ProtocolVersion,
    you: alice,
    owner: true,
    hubUpdate: { follows: { _tag: "Channel", channel: "stable" } },
    hubUpdateRun: {
      status: {
        id: "3f2a",
        source: "cli",
        startedAt: 1,
        finishedAt: 2,
        from: { commit: "a".repeat(40), version: "2026.10.2" },
        target: { ref: "v2026.10.4", commit: "c".repeat(40) },
        step: "Rolling back",
        state: "RolledBack",
        error: "The Hub wasn't healthy 30 seconds after it restarted.",
      },
      logTail: "== Rolling back\n$ git checkout --force v2026.10.2",
    },
  },
  { _tag: "HubUpdateStarted", requestId: "q-12c" },
  {
    _tag: "HubUpdateRunChanged",
    run: {
      status: {
        id: "3f2a",
        source: "hub",
        startedAt: 1,
        from: { commit: "a".repeat(40) },
        step: "Fetching",
        state: "Running",
      },
    },
  },
  {
    _tag: "HubUpdateChecked",
    requestId: "q-12b",
    update: {
      follows: { _tag: "Channel", channel: "stable" },
      checked: {
        at: 1,
        found: {
          _tag: "NewerRelease",
          releases: [
            {
              version: "2026.10.4",
              notes: "## Highlights",
              url: "https://github.com/kddige/kndl/releases/tag/v2026.10.4",
              publishedAt: 1,
            },
          ],
          compareUrl: "https://github.com/kddige/kndl/compare/v2026.10.2...v2026.10.4",
        },
      },
      failed: { at: 2, message: "GitHub answered 503" },
    },
  },
  {
    _tag: "HubUpdateChecked",
    update: {
      follows: { _tag: "Channel", channel: "dev" },
      checked: {
        at: 1,
        found: {
          _tag: "NewerCommits",
          head: "f".repeat(40),
          behindBy: 3,
          commits: [{ commit: "f".repeat(40), title: "web: the Hub page (#361)" }],
          compareUrl: "https://github.com/kddige/kndl/compare/a...f",
        },
      },
    },
  },
  {
    _tag: "HubUpdateChecked",
    update: {
      follows: { _tag: "Channel", channel: "stable" },
      checked: { at: 1, found: { _tag: "UpToDate" } },
    },
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
      mcpServers: [
        {
          id: "in-1",
          name: "Docs",
          mcpServerId: "hub:docs-search",
          mcpServerName: "Docs search",
          server: "docs",
        },
      ],
      mcpServersChanged: true,
    },
  },
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
    session: { ...sessionSummary, model: "sonnet", thinkingLevel: "high", modelPending: true },
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
        isOnline: true,
        version: null,
        versionStatus: "Unknown",
        lastSeenAt: 1_790_000_000_000,
        openSessions: 1,
        sysinfo: {
          diskFreeBytes: 200 * 1024 ** 3,
          diskTotalBytes: 500 * 1024 ** 3,
          memoryTotalBytes: 16 * 1024 ** 3,
          memoryAvailableBytes: 9 * 1024 ** 3,
          cpuCores: 8,
          loadAverage: [0.5, 0.75, 1.25],
          os: "linux",
          arch: "arm64",
          uptimeSeconds: 86_400,
          at: 1_790_000_000_000,
        },
      },
    ],
  },
  { _tag: "SessionRemoved", sessionId: "s-1" },
  { _tag: "ArchivedSessionPurged", requestId: "q-0", sessionId: "s-1", runnerOnline: true },
  { _tag: "ArchivedSessionPurged", requestId: "q-0", sessionId: "s-1", runnerOnline: false },
  // A size is absent where it isn't known: its Runner is offline, say (#352).
  {
    _tag: "SessionDiskUsage",
    requestId: "q-0",
    sizes: [{ sessionId: "s-1", bytes: 1_572_864 }, { sessionId: "s-2" }],
  },
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
    _tag: "ProvidersState",
    requestId: "q-40",
    connected: [
      {
        provider: "openai",
        kind: "SignIn",
        label: "ada@example.com",
        connectedAt: 1_700_000_000_000,
        models: [
          {
            provider: "openai",
            id: "gpt-6-sol",
            label: "GPT-6-Sol",
            thinkingLevels: ["low", "high"],
            contextWindow: 272_000,
          },
        ],
        modelsCheckedAt: 1_700_000_000_500,
      },
      {
        provider: "xai",
        kind: "ApiKey",
        label: "9f3b",
        connectedAt: 1_700_000_000_000,
        models: [],
        modelsProblem: "xAI answered 503",
        problem: "Connect it again: xAI refused to refresh the sign-in.",
      },
    ],
    connectable: [
      { provider: "openai", name: "OpenAI", signIn: "Sign in with ChatGPT", apiKey: true },
      { provider: "xai", name: "xAI", apiKey: true },
    ],
    models: [
      {
        provider: "anthropic",
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        thinkingLevels: [],
      },
    ],
  },
  {
    _tag: "SignInStepped",
    requestId: "q-42",
    provider: "openai",
    step: { _tag: "OpenUrl", url: "https://auth.openai.com/x", instructions: "Paste the URL" },
  },
  {
    _tag: "SignInStepped",
    requestId: "q-42",
    provider: "xai",
    step: { _tag: "EnterCode", url: "https://accounts.x.ai/device", code: "ABCD-EFGH" },
  },
  {
    _tag: "SignInStepped",
    requestId: "q-42",
    provider: "openai",
    step: {
      _tag: "Paste",
      message: "Paste the URL",
      placeholder: "http://127.0.0.1:1455/auth/callback",
    },
  },
  {
    _tag: "SignInStepped",
    requestId: "q-42",
    provider: "openai",
    step: { _tag: "Choose", message: "How?", options: [{ id: "browser", label: "Browser" }] },
  },
  {
    _tag: "SignInStepped",
    requestId: "q-42",
    provider: "openai",
    step: { _tag: "Progress", message: "Exchanging the code" },
  },
  { _tag: "SignInEnded", requestId: "q-42", provider: "openai", outcome: "Connected" },
  {
    _tag: "SignInEnded",
    requestId: "q-42",
    provider: "xai",
    outcome: "Failed",
    message: "Expired",
  },
  {
    _tag: "ClaudeCredentialState",
    requestId: "q-19",
    credential: { kind: "OAuthToken", last4: "ONLY", addedAt: 1_700_000_000_000 },
    warning: "Saved without checking it: Anthropic couldn't be reached.",
  },
  { _tag: "ListingUnavailable", requestId: "q-14" },
  { _tag: "ListingUnavailable", requestId: "q-14", hint: "Set GITHUB_APP_ID on the Hub." },
  { _tag: "ReposListed", requestId: "q-14", repos: [] },
  { _tag: "ReposListed", requestId: "q-14", repos: ["kddige/kndl", "kddige/other"] },
  {
    _tag: "BranchesListed",
    requestId: "q-15",
    repo: "kddige/kndl",
    branches: ["main", "feature/health-check"],
    defaultBranch: "main",
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
  {
    _tag: "RunnerHistory",
    requestId: "q-18",
    runnerId: "r-1",
    points: [
      { at: 1_790_000_000_000, diskFreeBytes: 200 * 1024 ** 3 },
      {
        at: 1_790_000_300_000,
        diskFreeBytes: 199 * 1024 ** 3,
        memoryAvailableBytes: 9 * 1024 ** 3,
        load1: 0.5,
      },
    ],
  },
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
  {
    _tag: "InviteCreated",
    requestId: "q-23",
    id: "inv-1",
    link: "https://hub.example.com/invite#chi_inv-1.secret",
    expiresAt: 1_700_604_800_000,
  },
  {
    _tag: "InviteCreated",
    requestId: "q-24",
    id: "inv-2",
    link: "https://hub.example.com/invite#chi_inv-2.secret",
    login: "Octo-Cat",
    expiresAt: 1_700_604_800_000,
  },
  { _tag: "InviteList", invites: [] },
  {
    _tag: "InviteList",
    requestId: "q-25",
    invites: [
      {
        id: "inv-2",
        login: "Octo-Cat",
        createdBy: alice,
        createdAt: 1_700_000_000_000,
        expiresAt: 1_700_604_800_000,
      },
    ],
  },
  {
    _tag: "MemberList",
    requestId: "q-27",
    members: [
      { participant: alice, owner: true, admittedAt: 1_700_000_000_000 },
      { participant: bob, owner: false, admittedAt: 1_700_000_060_000 },
    ],
  },
  {
    _tag: "McpServersState",
    requestId: "q-29",
    mcpServers: [
      {
        id: "hub:docs-search",
        name: "Docs search",
        url: "https://mcp.example.com/mcp",
        auth: {
          _tag: "Headers",
          headers: [
            { key: "token", title: "API key", header: "Authorization", template: "Bearer {value}" },
          ],
        },
        createdBy: alice,
        createdAt: 1_700_000_000_000,
      },
      {
        id: "@acme/linear-mcp",
        name: "Linear",
        description: "Linear's issues",
        url: "https://mcp.linear.app/mcp",
        auth: {
          _tag: "Headers",
          headers: [
            {
              key: "apiKey",
              title: "API key",
              header: "Authorization",
              template: "Bearer {value}",
            },
          ],
        },
        package: {
          version: "1.2.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          source: { _tag: "Git", url: "https://github.com/acme/linear-mcp.git", ref: "v1.2.0" },
        },
        createdBy: bob,
        createdAt: 1_700_000_030_000,
      },
      {
        id: "hub:github",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        auth: { _tag: "OAuth", scopes: ["repo"] },
        createdBy: alice,
        createdAt: 1_700_000_040_000,
      },
    ],
    installations: [
      {
        id: "in-1",
        mcpServerId: "hub:docs-search",
        name: "Docs",
        repos: ["kddige/kndl"],
        otherRepos: 1,
        values: [{ key: "token", setBy: alice, setAt: 1_700_000_090_000 }],
        createdBy: bob,
        createdAt: 1_700_000_060_000,
      },
      {
        id: "in-2",
        mcpServerId: "hub:github",
        name: "GitHub",
        repos: ["kddige/kndl"],
        otherRepos: 0,
        values: [],
        connection: {
          connectedBy: alice,
          connectedAt: 1_700_000_100_000,
          account: "kndl-bot@example.com",
          lostAt: 1_700_000_200_000,
        },
        client: { clientId: "Iv1.0a1b2c", secret: true, setBy: alice, setAt: 1_700_000_090_000 },
        createdBy: alice,
        createdAt: 1_700_000_070_000,
      },
    ],
  },
  {
    _tag: "InstallationAuthorizing",
    requestId: "q-35a",
    installationId: "in-2",
    url: "https://github.com/login/oauth/authorize?client_id=x&state=y",
  },
  {
    _tag: "InstallationNeedsClient",
    requestId: "q-35c",
    installationId: "in-2",
    issuer: "https://github.com/login/oauth",
    callbackUrl: "https://hub.example.com/auth/mcp/callback",
    publicClient: false,
    reason: "The client entered before was registered with another callback URL.",
  },
  { _tag: "McpServersState", mcpServers: [], installations: [] },
  {
    _tag: "McpServerLog",
    repo: "kddige/kndl",
    entries: [
      {
        at: 1_700_000_060_000,
        by: bob,
        change: "Created",
        mcpServerId: "hub:docs-search",
        mcpServerName: "Docs search",
        installationId: "in-1",
        installationName: "Docs",
      },
      {
        at: 1_700_000_090_000,
        by: alice,
        change: "ValuesSet",
        mcpServerId: "hub:docs-search",
        mcpServerName: "Docs search",
        installationId: "in-1",
        installationName: "Docs",
        secrets: ["API key"],
      },
      {
        at: 1_700_000_120_000,
        by: alice,
        change: "McpServerUpgraded",
        mcpServerId: "@acme/linear-mcp",
        mcpServerName: "Linear",
        mcpServerVersion: "1.3.0",
        installationId: "in-2",
        installationName: "Linear",
      },
      {
        at: 1_700_000_130_000,
        by: alice,
        change: "Connected",
        mcpServerId: "hub:github",
        mcpServerName: "GitHub",
        installationId: "in-3",
        installationName: "GitHub",
      },
      {
        at: 1_700_000_140_000,
        by: alice,
        change: "Reconnected",
        mcpServerId: "hub:github",
        mcpServerName: "GitHub",
        installationId: "in-3",
        installationName: "GitHub",
      },
      {
        at: 1_700_000_150_000,
        by: bob,
        change: "Disconnected",
        mcpServerId: "hub:github",
        mcpServerName: "GitHub",
        installationId: "in-3",
        installationName: "GitHub",
      },
    ],
  },
  {
    _tag: "McpServerPackageRead",
    requestId: "q-40",
    readId: "read-2",
    read: {
      id: "@acme/linear-mcp",
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      auth: { _tag: "None" },
      package: { version: "1.3.0", source: { _tag: "Upload", fileName: "linear-mcp-1.3.0.zip" } },
    },
    upgrades: "@acme/linear-mcp",
  },
  { _tag: "ThreadCreated", requestId: "q-43", sessionId: "s-1", threadId: "thr-1" },
  {
    _tag: "SessionModels",
    sessionId: "s-1",
    models: [
      {
        provider: "openai",
        id: "gpt-6-sol",
        label: "GPT-6-Sol",
        thinkingLevels: ["low", "medium", "high"],
      },
    ],
  },
  { _tag: "SessionModels", sessionId: "s-1", models: [] },
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
    // A reply's attachments come as ids beside it, never on the reply itself (#278).
    const replied = Schema.decodeUnknownSync(WebToHub)({
      _tag: "AnswerQuestion",
      sessionId: "s-1",
      toolCallId: "toolu_ask",
      answer: {
        _tag: "Replied",
        text: "like this",
        attachments: [{ id: "att-1", name: "a.png", mediaType: "image/png", size: 1 }],
      },
    })
    expect(replied._tag === "AnswerQuestion" && replied.answer).toEqual({
      _tag: "Replied",
      text: "like this",
    })
    expectRejected(WebToHub, { _tag: "MessageAgent", sessionId: "s-1", agentId: "a-1", text: "" })
    expectRejected(SessionEvent, { _tag: "AgentMessaged", agentId: "a-1", sender: alice, text: "" })
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
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expectRejected(WebToHub, { ...webToHub[1], repo: "kddige/kndl/extra" })
    // The old shape, from before a Session could work on a branch directly.
    expectRejected(WebToHub, {
      _tag: "CreateSession",
      requestId: "q-1",
      repo: "kddige/kndl",
      baseBranch: "main",
    })
    expectRejected(WebToHub, { ...webToHub[1], branch: { _tag: "Existing", name: "main" } })
    expectRejected(WebToHub, { ...webToHub[1], branch: { _tag: "Create", name: "x", from: "" } })
    for (const name of ["a b", "a..b", "-x", "x.lock", "x/", "a@{b", "a~b", "a:b", "HEAD"]) {
      expectRejected(WebToHub, {
        ...webToHub[1],
        branch: { _tag: "Create", name, from: "main" },
      })
    }
    expectRejected(WebToHub, { _tag: "ListBranches", requestId: "q-14" })
    expectRejected(WebToHub, { _tag: "JoinSession", sessionId: "s-1", afterSeq: -1 })
    expectRejected(WebToHub, { _tag: "CancelPrompt", sessionId: "s-1" })
    expectRejected(WebToHub, { _tag: "SteerPrompt", sessionId: "s-1" })
    expectRejected(WebToHub, { _tag: "DeliverPrompt", sessionId: "s-1", promptId: "p", text: "x" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", model: "" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", model: "-p" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", model: "x".repeat(201) })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", thinkingLevel: "extra" })
    expectRejected(WebToHub, { _tag: "SetSessionModel", sessionId: "s-1", thinkingLevel: "auto" })
    expectRejected(WebToHub, { ...webToHub[1], model: "son net" })
    // An Invite's login is a GitHub login, or none at all.
    for (const login of ["", "-octocat", "octo--cat", "octo cat", "x".repeat(40)]) {
      expectRejected(WebToHub, { _tag: "CreateInvite", requestId: "q-1", login })
    }
    expectRejected(WebToHub, { _tag: "RevokeInvite", requestId: "q-1", inviteId: "" })
    expectRejected(WebToHub, { _tag: "RemoveMember", requestId: "q-1" })
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
    expectRejected(HubToWeb, { _tag: "MemberList", members: [{ participant: alice }] })
    expectRejected(HubToWeb, {
      _tag: "InviteList",
      invites: [{ id: "inv-1", createdBy: alice, createdAt: 0 }],
    })
  })
})
