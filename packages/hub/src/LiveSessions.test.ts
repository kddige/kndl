// Each Session's live state (LiveSessions.ts): its transitions and the decisions it makes, and
// what each way it ends clears, and what it keeps. A change to what a way clears is a deliberate
// change to its row here.

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
import { type LiveSessions, makeLiveSessions, piecesOf, type SessionEnd } from "./LiveSessions.ts"
import { needlesOf, StreamRedactor } from "./Redaction.ts"

const id = SessionId.make("s-ended")
const other = SessionId.make("s-other")
const alice = { id: ParticipantId.make("p-alice"), login: "alice", name: "Alice", avatarUrl: "" }
const toolCallId = ToolCallId.make("tc-1")
const turnId = TurnId.make("t-1")

/** Gives the Session every piece of live state. */
const populate = (sessions: LiveSessions, sessionId: SessionId) => {
  const live = piecesOf(sessions)
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
  pieces.filter((piece) => piecesOf(live)[piece].has(sessionId))

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
  test("ClaudeGone clears what its Claude Code had going, its streams and the restart", () => {
    expect(keptAfter("ClaudeGone")).toEqual([
      "archiving",
      "lastBusy",
      "questionPicks",
      "closedQuestions",
      "asleepWhy",
      "sandboxTokens",
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
    ])
  })

  test("Archived clears deliveries, steers, starts, stops, Open ports and Installation trouble", () => {
    expect(keptAfter("Archived")).toEqual([
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

  test("RunnerGone clears what the Runner was asked, keeping what Claude Code may outlive it with", () => {
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

  test("Purged clears every piece: nothing is left of the Session", () => {
    expect(keptAfter("Purged")).toEqual([])
  })
})

describe("delivery", () => {
  const one = PromptId.make("pr-1")
  const two = PromptId.make("pr-2")

  test("a prompt is in flight from its delivery until a Turn starts from it", () => {
    const live = makeLiveSessions()
    expect(live.delivered(id, one)).toBe(false)
    live.delivering(id, one)
    expect(live.delivered(id, one)).toBe(true)
    expect(live.delivered(id, two)).toBe(false)
    expect(live.delivered(other, one)).toBe(false)
    // A Turn from another prompt, as one steered in, leaves it in flight.
    live.turnStarted(id, two)
    expect(live.delivered(id, one)).toBe(true)
    live.turnStarted(id, one)
    expect(live.delivered(id, one)).toBe(false)
  })

  test("a prompt the mod failed is no longer in flight, and no one steered it", () => {
    const live = makeLiveSessions()
    live.delivering(id, one)
    expect(live.promptFailed(id, two)).toBeUndefined()
    expect(live.delivered(id, one)).toBe(true)
    expect(live.promptFailed(id, one)).toBeUndefined()
    expect(live.delivered(id, one)).toBe(false)
  })

  test("a steer the mod failed or answered is over, and a failed one says who steered it", () => {
    const live = makeLiveSessions()
    live.steering.set(
      id,
      new Map([
        [one, alice.id],
        [two, alice.id],
      ]),
    )
    live.delivering(id, PromptId.make("pr-0"))
    expect(live.promptFailed(id, one)).toBe(alice.id)
    // Failing a steer leaves the prompt in flight alone.
    expect(live.delivered(id, PromptId.make("pr-0"))).toBe(true)
    expect(live.steering.get(id)?.has(two)).toBe(true)
    live.promptSteered(id, two)
    expect(live.steering.has(id)).toBe(false)
  })

  test("a start or relaunch waits for the new mod's hello, which says whether it steers", () => {
    const live = makeLiveSessions()
    const start = { since: 1, environmentVersion: undefined, log: "", attached: false }
    live.startSent(id, start)
    expect(live.starting.has(id)).toBe(true)
    expect(live.starts.get(id)).toBe(start)
    live.modHello(id, true)
    expect(live.starting.has(id)).toBe(false)
    expect(live.steers.has(id)).toBe(true)

    live.steering.set(id, new Map([[one, alice.id]]))
    live.relaunched(id)
    expect(live.starting.has(id)).toBe(true)
    expect(live.steering.has(id)).toBe(false)
    live.modHello(id, false)
    expect(live.steers.has(id)).toBe(false)
  })
})
