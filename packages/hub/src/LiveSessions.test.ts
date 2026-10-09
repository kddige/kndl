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

  test("a start or relaunch waits for the new mod's hello", () => {
    const live = makeLiveSessions()
    const start = { since: 1, environmentVersion: undefined, log: "", attached: false }
    live.startSent(id, start)
    expect(live.awaitingHello(id)).toBe(true)
    expect(live.starts.get(id)).toBe(start)
    live.modHello(id, true)
    expect(live.awaitingHello(id)).toBe(false)
    live.relaunched(id)
    expect(live.awaitingHello(id)).toBe(true)
  })
})

/** A Session whose mod said it steers. */
const steeringSession = () => {
  const live = makeLiveSessions()
  live.modHello(id, true)
  return live
}

/** A Refusal saying `refusal`. */
const refused = (refusal: string) => ({ refusal: expect.stringContaining(refusal) })

describe("steering", () => {
  const one = PromptId.make("pr-1")
  const two = PromptId.make("pr-2")
  const steering = { by: alice.id, turnRunning: true, queued: true }

  test("hands a queued prompt to the running Turn once, until the mod answers", () => {
    const live = steeringSession()
    expect(live.steer(id, { ...steering, promptId: one })).toBe("ok")
    expect(live.steer(id, { ...steering, promptId: one })).toBe("already")
    expect(live.cancelRefusal(id, one)).toEqual({
      refusal: "The prompt is being handed to the running Turn.",
    })
    expect(live.cancelRefusal(id, two)).toBeUndefined()
    live.promptSteered(id, one)
    expect(live.cancelRefusal(id, one)).toBeUndefined()
    expect(live.steer(id, { ...steering, promptId: one })).toBe("ok")
  })

  test("a steer the mod failed is over, and says who steered it, leaving the prompt in flight", () => {
    const live = steeringSession()
    live.delivering(id, two)
    expect(live.steer(id, { ...steering, promptId: one })).toBe("ok")
    expect(live.promptFailed(id, one)).toBe(alice.id)
    expect(live.delivered(id, two)).toBe(true)
    expect(live.cancelRefusal(id, one)).toBeUndefined()
  })

  test("is refused without a running Turn, for a prompt delivered or not queued, and by an old mod", () => {
    const live = steeringSession()
    expect(live.steer(id, { ...steering, promptId: one, turnRunning: false })).toEqual(
      refused("No Turn is running"),
    )
    live.delivering(id, one)
    expect(live.steer(id, { ...steering, promptId: one })).toEqual(refused("already delivered"))
    expect(live.cancelRefusal(id, one)).toEqual(refused("already delivered"))
    expect(live.steer(id, { ...steering, promptId: two, queued: false })).toEqual(
      refused("not in the Prompt queue"),
    )
    live.modHello(id, false)
    expect(live.steer(id, { ...steering, promptId: two })).toEqual(
      refused("a mod from before steering"),
    )
    // A relaunch's new mod hasn't said whether it steers: its old one's steers are dropped.
    live.modHello(id, true)
    expect(live.steer(id, { ...steering, promptId: two })).toBe("ok")
    live.relaunched(id)
    expect(live.cancelRefusal(id, two)).toBeUndefined()
  })
})

describe("stopping and restarting", () => {
  const restart = { by: alice, since: 5 }

  test("a stop is asked once until it is settled", () => {
    const live = makeLiveSessions()
    expect(live.stopAsked(id, { message: "Idle" })).toBe(true)
    expect(live.stopAsked(id, { message: "Put to sleep" })).toBe(false)
    expect(live.goingToSleep(id)).toBe(true)
    // Nor does a restart asked meanwhile take.
    expect(live.stopAsked(id, { message: "Restarting" }, restart)).toBe(false)
    expect(live.restarts.has(id)).toBe(false)
    live.ended(id, "ClaudeGone")
    expect(live.stopAsked(id, { message: "Restarting" }, restart)).toBe(true)
    expect(live.stopped(id)).toEqual({
      _tag: "Stop",
      asked: { message: "Restarting" },
      restartBy: alice,
    })
    expect(live.restarts.get(id)).toBe(restart)
  })

  test("a restart is over once the Session started again, or when no start is under way", () => {
    const live = makeLiveSessions()
    live.stopAsked(id, { message: "Restarting" }, restart)
    live.ended(id, "ClaudeGoneRestarting")
    expect(live.restarts.get(id)).toBe(restart)
    live.startSent(id, { since: 6, environmentVersion: undefined, log: "", attached: false })
    expect(live.restartOver(id)).toBe(false)
    live.claudeStarted(id)
    expect(live.starts.has(id)).toBe(false)
    expect(live.restarts.has(id)).toBe(false)
    expect(live.restartOver(id)).toBe(false)

    // An Asleep one woken for a restart that couldn't start.
    live.restartWaking(id, restart)
    expect(live.restartOver(id)).toBe(true)
    expect(live.restarts.has(id)).toBe(false)
  })
})

describe("a Runner saying a Session stopped", () => {
  test("settles the stop for good of an archive first, once", () => {
    const live = makeLiveSessions()
    live.stopAsked(id, { message: "Idle" })
    live.archiveStopAsked(id)
    expect(live.stopped(id)).toEqual({ _tag: "Archive" })
    // The stop for sleep is read next time, until Claude Code being gone clears it.
    expect(live.stopped(id)).toEqual({
      _tag: "Stop",
      asked: { message: "Idle" },
      restartBy: undefined,
    })
    live.ended(id, "ClaudeGone")
    expect(live.stopped(id)).toEqual({ _tag: "Stop", asked: undefined, restartBy: undefined })
  })

  test("says no restart for a stop not asked, whatever else is under way", () => {
    const live = makeLiveSessions()
    expect(live.stopped(id)).toEqual({ _tag: "Stop", asked: undefined, restartBy: undefined })
    expect(live.stopped(other)).toEqual({ _tag: "Stop", asked: undefined, restartBy: undefined })
  })
})

/** A StartSession just sent. */
const start = () => ({ since: 1, environmentVersion: undefined, log: "", attached: false })
/** The predicates' answers, by name. */
const doing = (live: LiveSessions, sessionId = id) => ({
  blocksDelivery: live.blocksDelivery(sessionId),
  settling: live.settling(sessionId),
  busy: live.busy(sessionId),
  promptOut: live.promptOut(sessionId),
  awaitingHello: live.awaitingHello(sessionId),
  goingToSleep: live.goingToSleep(sessionId),
  startUnderWay: live.startUnderWay(sessionId),
  archiveStopping: live.archiveStopping(sessionId),
})

describe("what a Session is doing", () => {
  const one = PromptId.make("pr-1")
  const nothing = {
    blocksDelivery: false,
    settling: false,
    busy: false,
    promptOut: false,
    awaitingHello: false,
    goingToSleep: false,
    startUnderWay: false,
    archiveStopping: false,
  }

  test("nothing, at first", () => {
    expect(doing(makeLiveSessions())).toEqual(nothing)
  })

  test("a prompt in flight blocks delivery and keeps it busy", () => {
    const live = makeLiveSessions()
    live.delivering(id, one)
    expect(doing(live)).toEqual({ ...nothing, blocksDelivery: true, busy: true, promptOut: true })
    expect(doing(live, other)).toEqual(nothing)
  })

  test("a start under way blocks delivery until the hello, and settles and keeps it busy until it started", () => {
    const live = makeLiveSessions()
    live.startSent(id, start())
    expect(doing(live)).toEqual({
      ...nothing,
      blocksDelivery: true,
      settling: true,
      busy: true,
      awaitingHello: true,
      startUnderWay: true,
    })
    live.modHello(id, true)
    expect(doing(live)).toEqual({ ...nothing, settling: true, busy: true, startUnderWay: true })
    live.claudeStarted(id)
    expect(doing(live)).toEqual(nothing)
    // A relaunch waits for the hello, with no start to settle.
    live.relaunched(id)
    expect(doing(live)).toEqual({ ...nothing, blocksDelivery: true, awaitingHello: true })
  })

  test("a stop asked blocks delivery, settles and keeps it busy", () => {
    const live = makeLiveSessions()
    live.stopAsked(id, { message: "Idle" })
    expect(doing(live)).toEqual({
      ...nothing,
      blocksDelivery: true,
      settling: true,
      busy: true,
      goingToSleep: true,
    })
  })

  test("a steer awaiting the mod's answer blocks delivery alone", () => {
    const live = makeLiveSessions()
    live.modHello(id, true)
    live.steer(id, { promptId: one, by: alice.id, turnRunning: true, queued: true })
    expect(doing(live)).toEqual({ ...nothing, blocksDelivery: true })
  })

  test("an archive's stop for good is only that", () => {
    const live = makeLiveSessions()
    live.archiveStopAsked(id)
    expect(doing(live)).toEqual({ ...nothing, archiveStopping: true })
    live.stopped(id)
    expect(doing(live)).toEqual(nothing)
  })
})
