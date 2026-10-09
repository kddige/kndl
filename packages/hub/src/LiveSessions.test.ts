// Each Session's live state (LiveSessions.ts): what each way it ends clears, and what it keeps.
// These pin the table as SessionRelay.ts cleared it by hand before; a follow-up that closes a gap
// changes its row here.

import { describe, expect, test } from "bun:test"
import {
  InstallationId,
  ParticipantId,
  PromptId,
  QuestionClosed,
  SessionId,
  ToolCallId,
  TurnId,
} from "@kndl/protocol"
import { type LiveSessions, makeLiveSessions, type SessionEnd } from "./LiveSessions.ts"
import { needlesOf, StreamRedactor } from "./Redaction.ts"

const id = SessionId.make("s-ended")
const other = SessionId.make("s-other")
const alice = { id: ParticipantId.make("p-alice"), login: "alice", name: "Alice", avatarUrl: "" }
const toolCallId = ToolCallId.make("tc-1")
const turnId = TurnId.make("t-1")

/** Gives the Session every piece of live state. */
const populate = (live: LiveSessions, sessionId: SessionId) => {
  const promptId = PromptId.make("pr-1")
  live.inFlight.set(sessionId, promptId)
  live.steering.set(sessionId, new Map([[promptId, alice.id]]))
  live.steers.add(sessionId)
  live.starting.add(sessionId)
  live.stopping.set(sessionId, { message: "Idle" })
  live.restarting.set(sessionId, alice)
  live.starts.set(sessionId, { since: 1, environmentVersion: undefined, log: "", attached: false })
  live.restarts.set(sessionId, { by: alice, since: 1 })
  live.archiving.add(sessionId)
  live.openPorts.set(sessionId, [{ port: 3000, addresses: ["0.0.0.0"] }])
  live.installationTrouble.set(sessionId, new Map([[InstallationId.make("i-1"), "Unauthorized"]]))
  live.lastBusy.set(sessionId, 1)
  live.questionPicks.set(sessionId, { toolCallId, picks: [] })
  live.closedQuestions.set(
    sessionId,
    QuestionClosed.make({ turnId, toolCallId, outcome: { _tag: "Cancelled" } }),
  )
  live.asleepWhy.set(sessionId, { message: "Idle" })
  live.sandboxTokens.set(sessionId, { repo: "acme/web", tokens: ["ghs_1"] })
  const redactor = new StreamRedactor(needlesOf([]))
  live.textStreams.set(
    sessionId,
    new Map([["t-1/", { turnId, agentId: undefined, redactor, flushing: false }]]),
  )
  live.terminalStreams.set(sessionId, { redactor, size: { cols: 80, rows: 24 }, flushing: false })
}

const pieces = [
  "inFlight",
  "steering",
  "steers",
  "starting",
  "stopping",
  "restarting",
  "starts",
  "restarts",
  "archiving",
  "openPorts",
  "installationTrouble",
  "lastBusy",
  "questionPicks",
  "closedQuestions",
  "asleepWhy",
  "sandboxTokens",
  "textStreams",
  "terminalStreams",
] as const

/** The pieces of live state the Session still has. */
const kept = (live: LiveSessions, sessionId: SessionId) =>
  pieces.filter((piece) => live[piece].has(sessionId))

/** Populates two Sessions, ends one `how`, and says what it kept. */
const keptAfter = (how: SessionEnd) => {
  const live = makeLiveSessions()
  populate(live, id)
  populate(live, other)
  expect(kept(live, id)).toEqual([...pieces])
  live.ended(id, how)
  // Another Session's state is never touched.
  expect(kept(live, other)).toEqual([...pieces])
  return kept(live, id)
}

describe("a Session's live state ending", () => {
  test("ClaudeGone clears what its Claude Code had going, and the restart", () => {
    expect(keptAfter("ClaudeGone")).toEqual([
      "archiving",
      "lastBusy",
      "questionPicks",
      "closedQuestions",
      "asleepWhy",
      "sandboxTokens",
      "textStreams",
      "terminalStreams",
    ])
  })

  test("ClaudeGoneRestarting is ClaudeGone keeping the restart", () => {
    expect(keptAfter("ClaudeGoneRestarting")).toEqual([
      "restarts",
      "archiving",
      "lastBusy",
      "questionPicks",
      "closedQuestions",
      "asleepWhy",
      "sandboxTokens",
      "textStreams",
      "terminalStreams",
    ])
  })

  test("Archived clears deliveries, starts and stops, keeping steering, Open ports and Installation trouble", () => {
    expect(keptAfter("Archived")).toEqual([
      "steering",
      "steers",
      "archiving",
      "openPorts",
      "installationTrouble",
      "lastBusy",
      "questionPicks",
      "closedQuestions",
      "asleepWhy",
      "sandboxTokens",
      "textStreams",
      "terminalStreams",
    ])
  })

  test("RunnerGone clears what the Runner was asked, keeping deliveries", () => {
    expect(keptAfter("RunnerGone")).toEqual([
      "inFlight",
      "steering",
      "steers",
      "starting",
      "openPorts",
      "installationTrouble",
      "lastBusy",
      "questionPicks",
      "closedQuestions",
      "asleepWhy",
      "sandboxTokens",
      "textStreams",
      "terminalStreams",
    ])
  })

  test("Purged clears what outlives the archive, keeping the rest", () => {
    expect(keptAfter("Purged")).toEqual([
      "inFlight",
      "steering",
      "steers",
      "starting",
      "stopping",
      "restarting",
      "starts",
      "restarts",
      "installationTrouble",
      "questionPicks",
      "closedQuestions",
      "textStreams",
      "terminalStreams",
    ])
  })
})
