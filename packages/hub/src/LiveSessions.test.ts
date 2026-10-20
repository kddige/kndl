// Each Session's live state (LiveSessions.ts): its transitions and the decisions it makes, and
// what each way it ends clears, and what it keeps. A change to what a way clears is a deliberate
// change to its row here.

import { describe, expect, test } from "bun:test"
import {
  EventSeq,
  InstallationId,
  ModCommandSeq,
  ParticipantId,
  PromptId,
  QuestionClosed,
  SessionId,
  ToolCallId,
  TurnId,
} from "@kndl/protocol"
import {
  type LiveSessions,
  makeLiveSessions,
  piecesOf,
  type SessionEnd,
  startLogLimit,
} from "./LiveSessions.ts"
import { needlesOf, StreamRedactor } from "./Redaction.ts"

const id = SessionId.make("s-ended")
const other = SessionId.make("s-other")
const alice = { id: ParticipantId.make("dev:alice"), login: "alice", name: "alice" }
const toolCallId = ToolCallId.make("tc-1")
const turnId = TurnId.make("t-1")

/** Gives the Session every piece of live state. */
const populate = (sessions: LiveSessions, sessionId: SessionId) => {
  const live = piecesOf(sessions)
  const promptId = PromptId.make("pr-1")
  live.inFlight.set(sessionId, promptId)
  live.steering.set(sessionId, new Map([[promptId, alice.id]]))
  live.greeted.add(sessionId)
  live.threadCommandsOut.set(sessionId, [{ seq: ModCommandSeq.make(2), pending: 1 }])
  live.handoffs.set(sessionId, {
    seq: ModCommandSeq.make(1),
    harness: "Pi",
    through: EventSeq.make(3),
  })
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
    new Map([
      ["t-1//", { turnId, agentId: undefined, threadId: undefined, redactor, flushing: false }],
    ]),
  )
  live.terminalStreams.set(sessionId, { redactor, size: { cols: 80, rows: 24 }, flushing: false })
}

const pieces = [
  "inFlight",
  "steering",
  "greeted",
  "threadCommandsOut",
  "handoffs",
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
      "greeted",
      "threadCommandsOut",
      "handoffs",
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
    expect(live.view(id).start).toBe(start)
    expect(live.modGreeted(id)).toBe(false)
    live.modHello(id)
    expect(live.awaitingHello(id)).toBe(false)
    expect(live.modGreeted(id)).toBe(true)
    live.relaunched(id)
    expect(live.awaitingHello(id)).toBe(true)
    expect(live.modGreeted(id)).toBe(false)
  })
})

/** A Session whose mod said hello. */
const steeringSession = () => {
  const live = makeLiveSessions()
  live.modHello(id)
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

  test("is refused without a running Turn, for a prompt delivered or not queued", () => {
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
    expect(live.view(id).restart).toBeUndefined()
    live.ended(id, "ClaudeGone")
    expect(live.stopAsked(id, { message: "Restarting" }, restart)).toBe(true)
    expect(live.stopped(id)).toEqual({
      _tag: "Stop",
      asked: { message: "Restarting" },
      restartBy: alice,
    })
    expect(live.view(id).restart).toBe(restart)
  })

  test("a restart is over once the Session started again, or when no start is under way", () => {
    const live = makeLiveSessions()
    live.stopAsked(id, { message: "Restarting" }, restart)
    live.ended(id, "ClaudeGoneRestarting")
    expect(live.view(id).restart).toBe(restart)
    live.startSent(id, { since: 6, environmentVersion: undefined, log: "", attached: false })
    expect(live.restartOver(id)).toBe(false)
    live.claudeStarted(id)
    expect(live.startUnderWay(id)).toBe(false)
    expect(live.view(id).restart).toBeUndefined()
    expect(live.restartOver(id)).toBe(false)

    // An Asleep one woken for a restart that couldn't start.
    live.restartWaking(id, restart)
    expect(live.restartOver(id)).toBe(true)
    expect(live.view(id).restart).toBeUndefined()
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
    live.modHello(id)
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
    live.modHello(id)
    live.steer(id, {
      promptId: one,
      by: alice.id,
      turnRunning: true,
      queued: true,
    })
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

describe("what is shown of a Session", () => {
  const ports = [{ port: 3000, addresses: ["0.0.0.0"], process: "node" }]

  test("nothing, at first", () => {
    expect(makeLiveSessions().view(id)).toEqual({
      start: undefined,
      restart: undefined,
      openPorts: undefined,
      asleepWhy: undefined,
    })
  })

  test("a start keeps its output until Claude Code's terminal is up, as the same start", () => {
    const live = makeLiveSessions()
    expect(live.startOutput(id, "nothing to keep")).toBeUndefined()
    const sent = start()
    live.startSent(id, sent)
    expect(live.startOutput(id, "")).toBeUndefined()
    expect(live.startOutput(id, "building\n")).toBe(1)
    expect(live.startOutput(id, "x".repeat(startLogLimit))).toBe(1)
    const shown = live.view(id).start
    // The same start, which a check that waited compares.
    expect(shown).toBe(sent)
    expect(shown?.log).toBe("x".repeat(startLogLimit))
    live.startAttached(id)
    expect(live.startOutput(id, "Claude's")).toBeUndefined()
    expect(live.view(id).start?.attached).toBe(true)
  })

  test("Open ports are kept as reported, until it is no longer Active", () => {
    const live = makeLiveSessions()
    expect(live.portsReported(id, ports)).toEqual([])
    expect(live.view(id).openPorts).toBe(ports)
    expect(live.portsReported(id, [])).toBe(ports)
    expect(live.view(id).openPorts).toBeUndefined()
    live.portsReported(id, ports)
    live.stateChanged(id, "Active", {})
    expect(live.view(id).openPorts).toBe(ports)
    live.stateChanged(id, "Frozen", {})
    expect(live.view(id).openPorts).toBeUndefined()
  })

  test("an Asleep Session shows why it last went Asleep", () => {
    const live = makeLiveSessions()
    live.stateChanged(id, "Asleep", { message: "Idle" })
    live.stateChanged(id, "Active", { message: "Woken" })
    expect(live.view(id).asleepWhy).toEqual({ message: "Idle" })
  })
})

describe("idleness", () => {
  test("a Session is idle from the first check that finds it so, until it is seen busy", () => {
    const live = makeLiveSessions()
    expect(live.idleSince(id, 10)).toBeUndefined()
    expect(live.idleSince(id, 20)).toBe(10)
    live.seenBusy(id, 30)
    expect(live.idleSince(id, 40)).toBe(30)
    expect(live.idleSince(other, 40)).toBeUndefined()
  })
})

describe("Open questions", () => {
  const bob = { id: ParticipantId.make("dev:bob"), login: "bob", name: "bob" }
  const pick = { toolCallId, question: "Which library?" }

  test("keeps each Participant's latest pick for each question, until the question closes", () => {
    const live = makeLiveSessions()
    expect(live.picks(id)).toBeUndefined()
    live.picked(id, { ...pick, participant: alice, answer: "date-fns" })
    live.picked(id, { ...pick, participant: bob, answer: "luxon" })
    expect(
      live.picked(id, { ...pick, participant: alice, answer: "dayjs" }).map((p) => p.answer),
    ).toEqual(["luxon", "dayjs"])
    // An empty answer takes the pick back.
    expect(live.picked(id, { ...pick, participant: bob, answer: "" }).map((p) => p.answer)).toEqual(
      ["dayjs"],
    )
    expect(live.picks(id)?.toolCallId).toBe(toolCallId)

    const closed = QuestionClosed.make({ turnId, toolCallId, outcome: { _tag: "Cancelled" } })
    live.questionClosed(id, closed)
    expect(live.picks(id)).toBeUndefined()
    expect(live.closedQuestion(id)).toBe(closed)
  })

  test("a new question starts with no picks, and picks for another question are dropped", () => {
    const live = makeLiveSessions()
    live.picked(id, { ...pick, participant: alice, answer: "date-fns" })
    live.questionAsked(id)
    expect(live.picks(id)).toBeUndefined()
    live.picked(id, { ...pick, participant: alice, answer: "date-fns" })
    const next = ToolCallId.make("tc-2")
    expect(
      live.picked(id, { ...pick, toolCallId: next, participant: bob, answer: "luxon" }),
    ).toHaveLength(1)
  })
})

describe("Sandbox tokens and Installations", () => {
  test("a Repo's Sessions' Sandbox tokens are the current one and the one before, each", () => {
    const live = makeLiveSessions()
    live.sandboxTokenMinted(id, "acme/web", "ghs_1")
    live.sandboxTokenMinted(id, "acme/web", "ghs_2")
    live.sandboxTokenMinted(id, "acme/web", "ghs_3")
    live.sandboxTokenMinted(other, "Acme/Web", "ghs_9")
    live.sandboxTokenMinted(SessionId.make("s-third"), "acme/api", "ghs_x")
    expect(live.sandboxTokensOf("ACME/web")).toEqual(["ghs_2", "ghs_3", "ghs_9"])
  })

  test("an Installation's failure is news once, until it works again or says another why", () => {
    const live = makeLiveSessions()
    const linear = InstallationId.make("i-1")
    expect(live.installationFailing(id, linear, "Unauthorized 401")).toBe(true)
    expect(live.installationFailing(id, linear, "Unauthorized 401")).toBe(false)
    expect(live.installationFailing(other, linear, "Unauthorized 401")).toBe(true)
    expect(live.installationFailing(id, linear, "Forbidden 403")).toBe(true)
    live.installationWorks(id, linear)
    expect(live.installationFailing(id, linear, "Forbidden 403")).toBe(true)
  })
})
