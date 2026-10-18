// A Session's log (SessionLog.ts), on a real database: read whole, after an entry, or a few Turns
// back from the end, as `GET /mod/history` and a context handoff read it (ADR 0030).

import { describe, expect, test } from "bun:test"
import {
  AgentId,
  EventSeq,
  ParticipantId,
  type SessionEvent,
  SessionId,
  TurnId,
} from "@kndl/protocol"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "./Database.ts"
import { buildHandoff, HandoffReadTurns, readHandoff } from "./Handoff.ts"
import { SessionLog } from "./SessionLog.ts"

const sessionId = SessionId.make("s-1")
const ada = { id: ParticipantId.make("dev:ada"), login: "ada", name: "Ada" }

/** Runs `effect` on a fresh database holding one Session. */
const onLog = <A>(effect: Effect.Effect<A, unknown, SessionLog | SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
        VALUES ('dev:ada', 'ada', 'Ada', 1, 1)`
      yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
        VALUES ('r-1', 'mac', 'hash', 1)`
      yield* sql`
        INSERT INTO sessions (id, repo, base_branch, work_branch, state, runner_id, creator_id,
          created_at)
        VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Active', 'r-1', 'dev:ada', 1)
      `
      return yield* effect
    }).pipe(Effect.provide(SessionLog.layer.pipe(Layer.provideMerge(DatabaseTest)))),
  )

const started = (id: string): SessionEvent => ({
  _tag: "TurnStarted",
  turnId: TurnId.make(id),
  text: id,
  sender: { _tag: "FromParticipant", participant: ada },
})
const said = (id: string): SessionEvent => ({
  _tag: "TextDelta",
  turnId: TurnId.make(id),
  text: `${id} done`,
})
const ended = (id: string): SessionEvent => ({
  _tag: "TurnEnded",
  turnId: TurnId.make(id),
  reason: "stop",
  durationMs: 1,
})

/** Appends a note, then three main-loop Turns, a subagent's work among them. */
const appendTurns = Effect.gen(function* () {
  const log = yield* SessionLog
  for (const event of [
    { _tag: "SessionStateChanged", state: "Active" } as const,
    started("t-1"),
    said("t-1"),
    ended("t-1"),
    started("t-2"),
    {
      _tag: "TextDelta",
      turnId: TurnId.make("a-1"),
      agentId: AgentId.make("a-1"),
      text: "a",
    } as const,
    said("t-2"),
    ended("t-2"),
    started("t-3"),
    said("t-3"),
    ended("t-3"),
  ]) {
    yield* log.append(sessionId, event)
  }
})

const seqsOf = (entries: ReadonlyArray<{ readonly seq: EventSeq }>): Array<number> =>
  entries.map((entry) => entry.seq)

describe("a Session's last Turns", () => {
  test("are its log from the start of the main loop's Turn so many back, and whether any are before", async () => {
    const read = await onLog(
      Effect.gen(function* () {
        yield* appendTurns
        const log = yield* SessionLog
        return {
          lastTwo: yield* log.lastTurns(sessionId, { count: 2 }),
          before: yield* log.lastTurns(sessionId, { count: 2, before: EventSeq.make(4) }),
          all: yield* log.lastTurns(sessionId, { count: 5 }),
          afterOne: yield* log.lastTurns(sessionId, { count: 5, after: EventSeq.make(3) }),
        }
      }),
    )
    expect(seqsOf(read.lastTwo.entries)).toEqual([4, 5, 6, 7, 8, 9, 10])
    expect(read.lastTwo.earlier).toBe(true)
    expect(seqsOf(read.before.entries)).toEqual([0, 1, 2, 3])
    expect(read.before.earlier).toBe(false)
    // Fewer Turns than asked for: all of it, the note before the first among it.
    expect(seqsOf(read.all.entries)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(read.all.earlier).toBe(false)
    expect(seqsOf(read.afterOne.entries)).toEqual([4, 5, 6, 7, 8, 9, 10])
    expect(read.afterOne.earlier).toBe(false)
  })
})

/**
 * A handoff read back a few Turns at a time, and of the whole log, after `turns` Turns each
 * answering `size` characters, and the last entry.
 */
const handoffs = (turns: number, size: number) =>
  onLog(
    Effect.gen(function* () {
      const log = yield* SessionLog
      for (let i = 0; i < turns; i++) {
        yield* log.append(sessionId, started(`t-${i}`))
        yield* log.append(sessionId, {
          _tag: "TextDelta",
          turnId: TurnId.make(`t-${i}`),
          text: "y".repeat(size),
        })
        yield* log.append(sessionId, ended(`t-${i}`))
      }
      const seen = EventSeq.make(5)
      const read = yield* readHandoff((range) =>
        log.lastTurns(sessionId, { ...range, after: seen }),
      )
      const whole = yield* log.history(sessionId, seen)
      return { read, whole: buildHandoff({ entries: whole }), last: whole.at(-1)?.seq }
    }),
  )

describe("a context handoff read back a few Turns at a time", () => {
  test("is the handoff of all the log after where its Harness saw it", async () => {
    // More Turns than are read at a time, all of which fit.
    const small = await handoffs(HandoffReadTurns * 2 + 7, 10)
    expect(small.read.handoff).toEqual(small.whole)
    expect(small.read.handoff?.earlierBefore).toBeUndefined()
    expect(small.read.through).toBe(small.last)
    // Too many to fit: the newest that do, and where the earlier ones start.
    const large = await handoffs(HandoffReadTurns * 3, 1_500)
    expect(large.read.handoff).toEqual(large.whole)
    expect(large.read.handoff?.earlierBefore).toBeDefined()
    expect(large.read.through).toBe(large.last)
  })
})
