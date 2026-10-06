import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HubToRunner, RunnerToHub } from "./Runner.ts"
import {
  environmentRecipe,
  expectEveryTag,
  expectRejected,
  expectRoundTrips,
  runnerLogin,
  runnerModels,
} from "./testSupport.ts"
import { ProtocolVersion } from "./Version.ts"

const size = { cols: 160, rows: 48 }

const runnerToHub = [
  {
    _tag: "RunnerHello",
    protocolVersion: ProtocolVersion,
    name: "studio",
    login: runnerLogin,
    sessions: ["s-1", "s-2"],
  },
  { _tag: "SessionStarted", sessionId: "s-1" },
  { _tag: "SessionStartFailed", sessionId: "s-1", message: "clone failed: repository not found" },
  { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested" },
  {
    _tag: "SessionStopped",
    sessionId: "s-1",
    reason: "Exited",
    exitCode: 1,
    output: "error: The current working directory was deleted\n",
  },
  { _tag: "SandboxStateReport", sessionId: "s-1", state: "Running" },
  { _tag: "SandboxStateReport", sessionId: "s-1", state: "Failed", message: "out of memory" },
  {
    _tag: "TerminalFrame",
    sessionId: "s-1",
    kind: "Snapshot",
    data: "\u001b[2J\u001b[H> ready",
    size,
  },
  { _tag: "TerminalFrame", sessionId: "s-1", kind: "Output", data: "x", size },
  { _tag: "GitRequest", requestId: "g-1", sessionId: "s-1", ask: { _tag: "GitAccess" } },
  { _tag: "GitRequest", requestId: "g-2", sessionId: "s-1", ask: { _tag: "SandboxToken" } },
  { _tag: "WipPushFailed", sessionId: "s-1", message: "git push exited with 128" },
  { _tag: "SessionPurged", sessionId: "s-1" },
  { _tag: "SandboxNote", sessionId: "s-1", message: "Memory capped at 8192 MiB by the Runner" },
  { _tag: "SessionStarted", sessionId: "s-1", environmentVersion: 3 },
  { _tag: "FetchVariables", requestId: "v-1", for: { _tag: "Session", sessionId: "s-1" } },
  { _tag: "FetchVariables", requestId: "v-2", for: { _tag: "TestBuild", testBuildId: "b-1" } },
  { _tag: "FetchCloneAccess", requestId: "g-3", testBuildId: "b-1" },
  { _tag: "FetchClaudeCredential", requestId: "c-1", sessionId: "s-1" },
  {
    _tag: "RunnerHello",
    protocolVersion: ProtocolVersion,
    name: "studio",
    login: runnerLogin,
    sessions: [],
    asksCloneAccess: true,
  },
  {
    _tag: "RunnerHello",
    protocolVersion: ProtocolVersion,
    name: "studio",
    login: runnerLogin,
    sessions: ["s-1", "s-2"],
    withoutModToken: ["s-1"],
  },
  { _tag: "TestBuildLog", testBuildId: "b-1", data: "Reading package lists...\n" },
  { _tag: "TestBuildFinished", testBuildId: "b-1", result: "Passed" },
  {
    _tag: "TestBuildFinished",
    testBuildId: "b-1",
    result: "Failed",
    message: "The start script exited with 1",
  },
  { _tag: "UpdateChecked", target: { commit: "a".repeat(40), branch: "main" } },
  {
    _tag: "UpdateChecked",
    target: { commit: "a".repeat(40), branch: "main" },
    refusal: { reason: "NotOnMain", message: "Not reachable from origin/main" },
  },
  {
    _tag: "UpdateProgress",
    target: { commit: "a".repeat(40), branch: "main" },
    step: "Installing",
  },
  {
    _tag: "UpdateFailed",
    failure: {
      target: { commit: "a".repeat(40), branch: "main" },
      message: "bun install failed",
      rolledBack: true,
      at: 1,
    },
  },
  {
    _tag: "RunnerHello",
    protocolVersion: ProtocolVersion,
    name: "studio",
    login: runnerLogin,
    sessions: [],
    models: runnerModels,
    relaunches: true,
  },
]

const hubToRunner = [
  { _tag: "RunnerWelcome", protocolVersion: ProtocolVersion, runnerId: "r-1" },
  {
    _tag: "HandshakeRejected",
    reason: "ProtocolVersionMismatch",
    protocolVersion: ProtocolVersion,
    message: "update",
  },
  {
    _tag: "StartSession",
    sessionId: "s-1",
    repo: "kddige/claude-hub",
    baseBranch: "main",
    workBranch: "claude/s-1",
    modToken: "mod-token",
  },
  {
    _tag: "StartSession",
    sessionId: "s-1",
    repo: "kddige/claude-hub",
    baseBranch: "main",
    workBranch: "claude/s-1",
    resume: "0b6d6c1e-claude",
    modToken: "mod-token",
  },
  {
    _tag: "StartSession",
    sessionId: "s-2",
    repo: "kddige/claude-hub",
    baseBranch: "main",
    workBranch: "claude/s-2",
    modToken: "mod-token",
    parent: { id: "s-1", title: "Release" },
  },
  { _tag: "StopSession", sessionId: "s-1", reason: "Sleep" },
  { _tag: "StopSession", sessionId: "s-1", reason: "Archive" },
  { _tag: "PurgeSession", sessionId: "s-1" },
  { _tag: "TerminalInput", sessionId: "s-1", data: "\r" },
  { _tag: "TerminalResize", sessionId: "s-1", size },
  { _tag: "RequestTerminalSnapshot", sessionId: "s-1" },
  {
    _tag: "GitReply",
    requestId: "g-1",
    answer: {
      _tag: "GitAccess",
      repo: "kddige/claude-hub",
      credentials: {
        _tag: "AppToken",
        token: "ghs_installation",
        expiresAt: 1_790_000_000_000,
        author: {
          name: "claude-hub[bot]",
          email: "41898282+claude-hub[bot]@users.noreply.github.com",
        },
      },
    },
  },
  {
    _tag: "GitReply",
    requestId: "g-1",
    answer: {
      _tag: "GitAccess",
      repo: "kddige/claude-hub",
      credentials: { _tag: "HostCredentials" },
    },
  },
  {
    _tag: "GitReply",
    requestId: "g-2",
    answer: { _tag: "SandboxToken", token: "ghs_sandbox", expiresAt: 1_790_000_000_000 },
  },
  {
    _tag: "GitReply",
    requestId: "g-2",
    answer: { _tag: "GitFailed", message: "The Hub has no GitHub App" },
  },
  {
    _tag: "GitReply",
    requestId: "g-3",
    answer: {
      _tag: "CloneAccess",
      credentials: { _tag: "CloneToken", token: "ghs_clone", expiresAt: 1_790_000_000_000 },
    },
  },
  {
    _tag: "GitReply",
    requestId: "g-3",
    answer: { _tag: "CloneAccess", credentials: { _tag: "HostCredentials" } },
  },
  { _tag: "SessionTurnEnded", sessionId: "s-1" },
  {
    _tag: "StartSession",
    sessionId: "s-1",
    repo: "kddige/claude-hub",
    baseBranch: "main",
    workBranch: "claude/s-1",
    modToken: "mod-token",
    environment: { version: 3, buildVersion: 2, recipe: environmentRecipe },
  },
  {
    _tag: "RunTestBuild",
    testBuildId: "b-1",
    repo: "kddige/claude-hub",
    recipe: environmentRecipe,
  },
  {
    _tag: "VariablesFetched",
    requestId: "v-1",
    variables: [
      { name: "NODE_ENV", value: "development", availableAtBuild: true },
      { name: "NPM_TOKEN", value: "npm_secret", availableAtBuild: true },
    ],
  },
  { _tag: "VariablesRefused", requestId: "v-2", message: "Not a Test build this Runner runs" },
  {
    _tag: "ClaudeCredentialFetched",
    requestId: "c-1",
    credential: {
      _tag: "OAuthToken",
      token: "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY",
      plan: { subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
    },
  },
  {
    _tag: "ClaudeCredentialFetched",
    requestId: "c-2",
    credential: { _tag: "ApiKey", key: "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY" },
  },
  { _tag: "ClaudeCredentialFetched", requestId: "c-3" },
  { _tag: "ClaudeCredentialRefused", requestId: "c-4", message: "Not a Session this Runner runs" },
  { _tag: "CheckUpdate", target: { commit: "a".repeat(40), branch: "main" } },
  { _tag: "ApplyUpdate", target: { commit: "a".repeat(40) } },
  {
    _tag: "StartSession",
    sessionId: "s-1",
    repo: "kddige/claude-hub",
    baseBranch: "main",
    workBranch: "claude/s-1",
    modToken: "mod-token",
    model: "sonnet",
    effort: "xhigh",
  },
  {
    _tag: "RelaunchSession",
    sessionId: "s-1",
    repo: "kddige/claude-hub",
    workBranch: "claude/s-1",
    resume: "0b6d6c1e-claude",
    modToken: "mod-2",
  },
  {
    _tag: "RelaunchSession",
    sessionId: "s-2",
    repo: "kddige/claude-hub",
    workBranch: "claude/s-2",
    resume: "0b6d6c1e-claude",
    modToken: "mod-3",
    parent: { id: "s-1", title: "Release" },
    model: "opus[1m]",
    effort: "max",
  },  // A Runner kept s-1 running across its restart: a new mod token for it (#157).
  { _tag: "ModTokenReissued", sessionId: "s-1", modToken: "mod-4" },
]

describe("RunnerToHub", () => {
  test("round-trips every message", () => {
    expectEveryTag(RunnerToHub, runnerToHub)
    expectRoundTrips(RunnerToHub, runnerToHub)
  })

  test("rejects malformed messages", () => {
    expectRejected(RunnerToHub, { _tag: "SessionAdopted", sessionId: "s-1" })
    expectRejected(RunnerToHub, { sessionId: "s-1" })
    expectRejected(RunnerToHub, { _tag: "SessionStarted", sessionId: "" })
    expectRejected(RunnerToHub, { _tag: "SessionStarted" })
    expectRejected(RunnerToHub, { ...runnerToHub[0], login: { account: "" } })
    expectRejected(RunnerToHub, { _tag: "SandboxStateReport", sessionId: "s-1", state: "Asleep" })
    expectRejected(RunnerToHub, {
      _tag: "SessionStopped",
      sessionId: "s-1",
      reason: "Exited",
      exitCode: 1.5,
    })
    expectRejected(RunnerToHub, { ...runnerToHub[7], size: { cols: 0, rows: 48 } })
    expectRejected(RunnerToHub, { ...runnerToHub[7], kind: "Delta" })
    expectRejected(RunnerToHub, {
      _tag: "GitRequest",
      requestId: "",
      sessionId: "s-1",
      ask: { _tag: "SandboxToken" },
    })
    expectRejected(RunnerToHub, {
      _tag: "GitRequest",
      requestId: "g",
      sessionId: "s-1",
      ask: { _tag: "Push" },
    })
    expectRejected(RunnerToHub, { _tag: "CoAuthorsCommitted", sessionId: "s-1", through: 1 })
    expectRejected(RunnerToHub, { _tag: "SessionStarted", sessionId: "s-1", environmentVersion: 0 })
    expectRejected(RunnerToHub, { _tag: "FetchVariables", requestId: "v-1", for: { _tag: "Repo" } })
    expectRejected(RunnerToHub, { _tag: "TestBuildFinished", testBuildId: "b-1", result: "Ok" })
  })
})

describe("HubToRunner", () => {
  test("round-trips every message", () => {
    expectEveryTag(HubToRunner, hubToRunner)
    expectRoundTrips(HubToRunner, hubToRunner)
  })

  test("rejects malformed messages", () => {
    expectRejected(HubToRunner, { ...hubToRunner[2], repo: "claude-hub" })
    expectRejected(HubToRunner, { _tag: "ModTokenReissued", sessionId: "s-1", modToken: "" })
    expectRejected(HubToRunner, { ...hubToRunner[2], workBranch: "" })
    expectRejected(HubToRunner, { ...hubToRunner[2], modToken: undefined })
    expectRejected(HubToRunner, { _tag: "StopSession", sessionId: "s-1", reason: "Delete" })
    expectRejected(HubToRunner, { _tag: "TerminalInput", sessionId: "s-1", data: "" })
    expectRejected(HubToRunner, { _tag: "TerminalResize", sessionId: "s-1", size: { cols: 80 } })
    expectRejected(HubToRunner, {
      _tag: "GitReply",
      requestId: "g-1",
      answer: {
        _tag: "GitAccess",
        repo: "kddige/claude-hub",
        credentials: {
          _tag: "AppToken",
          token: "",
          expiresAt: 1,
          author: { name: "b", email: "e" },
        },
      },
    })
    expectRejected(HubToRunner, { _tag: "GitReply", requestId: "g-1", answer: { _tag: "Token" } })
    expectRejected(HubToRunner, { ...hubToRunner[2], model: "--dangerously-skip-permissions" })
    expectRejected(HubToRunner, { ...hubToRunner[2], model: "opus plan" })
    expectRejected(HubToRunner, { ...hubToRunner[2], effort: "extra" })
    expectRejected(HubToRunner, {
      _tag: "RelaunchSession",
      sessionId: "s-1",
      repo: "kddige/claude-hub",
      workBranch: "claude/s-1",
      modToken: "m",
    })
  })

  test("keeps variable values redacted once decoded", () => {
    const fetched = hubToRunner.find((message) => message._tag === "VariablesFetched")
    const decoded = Schema.decodeUnknownSync(HubToRunner)(fetched)
    expect(String(JSON.stringify(decoded))).not.toContain("npm_secret")
    expect(String(decoded)).not.toContain("npm_secret")
  })

  test("keeps an installation token redacted once decoded", () => {
    const reply = Schema.decodeUnknownSync(HubToRunner)(hubToRunner[9])
    expect(String(JSON.stringify(reply))).not.toContain("ghs_installation")
  })
})
