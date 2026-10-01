import { describe, test } from "bun:test"
import { HubToRunner, RunnerToHub } from "./Runner.ts"
import { expectEveryTag, expectRejected, expectRoundTrips, runnerLogin } from "./testSupport.ts"
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
  { _tag: "SessionStopped", sessionId: "s-1", reason: "Exited", exitCode: 1 },
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
  { _tag: "StopSession", sessionId: "s-1", reason: "Sleep" },
  { _tag: "StopSession", sessionId: "s-1", reason: "Archive" },
  { _tag: "TerminalInput", sessionId: "s-1", data: "\r" },
  { _tag: "TerminalResize", sessionId: "s-1", size },
  { _tag: "RequestTerminalSnapshot", sessionId: "s-1" },
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
  })
})

describe("HubToRunner", () => {
  test("round-trips every message", () => {
    expectEveryTag(HubToRunner, hubToRunner)
    expectRoundTrips(HubToRunner, hubToRunner)
  })

  test("rejects malformed messages", () => {
    expectRejected(HubToRunner, { ...hubToRunner[2], repo: "claude-hub" })
    expectRejected(HubToRunner, { ...hubToRunner[2], workBranch: "" })
    expectRejected(HubToRunner, { ...hubToRunner[2], modToken: undefined })
    expectRejected(HubToRunner, { _tag: "StopSession", sessionId: "s-1", reason: "Delete" })
    expectRejected(HubToRunner, { _tag: "TerminalInput", sessionId: "s-1", data: "" })
    expectRejected(HubToRunner, { _tag: "TerminalResize", sessionId: "s-1", size: { cols: 80 } })
  })
})
