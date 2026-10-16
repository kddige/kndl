// What the Hub asks its Runners of the disk their Sessions take (#352): the cache, the timeout, and
// what a Runner that is offline or too old, or that goes away mid-ask, makes of the answer.

import { describe, expect, test } from "bun:test"
import {
  type MeasureSessionDisks,
  RequestId,
  RunnerId,
  type SessionDisksMeasured,
  SessionId,
} from "@kndl/protocol"
import { Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  makeSessionDiskUsage,
  SessionDiskAskTimeoutMillis,
  SessionDiskCacheMillis,
} from "./SessionDiskUsage.ts"

const studio = RunnerId.make("r-studio")
const s1 = SessionId.make("s-1")
const s2 = SessionId.make("s-2")
const s3 = SessionId.make("s-3")

/** A Runner that records the asks it gets. */
const runner = (options: { readonly measuresDisk?: boolean } = {}) => {
  const asked: Array<MeasureSessionDisks> = []
  return {
    asked,
    /** The nth ask the Runner got. */
    ask: (n: number) => {
      const ask = asked[n]
      if (ask === undefined) throw new Error(`the Runner got no ask ${n}`)
      return ask
    },
    online: {
      id: studio,
      measuresDisk: options.measuresDisk ?? true,
      peer: { send: (message: MeasureSessionDisks) => void asked.push(message) },
    },
  }
}

const answer = (
  ask: MeasureSessionDisks,
  sizes: SessionDisksMeasured["sizes"],
): SessionDisksMeasured => ({ _tag: "SessionDisksMeasured", requestId: ask.requestId, sizes })

const run = <A>(effect: Effect.Effect<A, never, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

/** Lets a forked ask send what it will. */
const settle = Effect.yieldNow

describe("the disk Sessions take", () => {
  test("asks the Runner for the Sessions and returns what it says", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const r = runner()
        const fiber = yield* Effect.forkChild(usage.measure(r.online, [s1, s2]))
        yield* settle
        expect(r.asked).toEqual([
          { _tag: "MeasureSessionDisks", requestId: expect.any(String), sessionIds: [s1, s2] },
        ])
        usage.receive(studio, answer(r.ask(0), [{ sessionId: s1, bytes: 10 }, { sessionId: s2 }]))
        // Sizes the Runner left out are unknown, not zero.
        expect(yield* Fiber.join(fiber)).toEqual(new Map([[s1, 10]]))
      }),
    ))

  test("keeps what a Runner said for a minute, and asks again after", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const r = runner()
        const first = yield* Effect.forkChild(usage.measure(r.online, [s1]))
        yield* settle
        usage.receive(studio, answer(r.ask(0), [{ sessionId: s1, bytes: 10 }]))
        yield* Fiber.join(first)

        yield* TestClock.adjust(Duration.millis(SessionDiskCacheMillis - 1))
        expect(yield* usage.measure(r.online, [s1])).toEqual(new Map([[s1, 10]]))
        expect(r.asked).toHaveLength(1)

        // A Session not cached is asked for alone.
        const second = yield* Effect.forkChild(usage.measure(r.online, [s1, s2]))
        yield* settle
        expect(r.asked[1]?.sessionIds).toEqual([s2])
        usage.receive(studio, answer(r.ask(1), [{ sessionId: s2, bytes: 5 }]))
        expect(yield* Fiber.join(second)).toEqual(
          new Map([
            [s1, 10],
            [s2, 5],
          ]),
        )

        yield* TestClock.adjust(Duration.millis(SessionDiskCacheMillis))
        const third = yield* Effect.forkChild(usage.measure(r.online, [s1]))
        yield* settle
        expect(r.asked[2]?.sessionIds).toEqual([s1])
        usage.receive(studio, answer(r.ask(2), [{ sessionId: s1, bytes: 12 }]))
        expect(yield* Fiber.join(third)).toEqual(new Map([[s1, 12]]))
      }),
    ))

  test("a purged Session is forgotten", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const r = runner()
        const first = yield* Effect.forkChild(usage.measure(r.online, [s1]))
        yield* settle
        usage.receive(studio, answer(r.ask(0), [{ sessionId: s1, bytes: 10 }]))
        yield* Fiber.join(first)
        usage.forget(s1)
        expect(yield* usage.measure(undefined, [s1])).toEqual(new Map())
      }),
    ))

  test("knows nothing of a Runner that is offline, or too old to measure, and asks it nothing", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const old = runner({ measuresDisk: false })
        expect(yield* usage.measure(undefined, [s1])).toEqual(new Map())
        expect(yield* usage.measure(old.online, [s1])).toEqual(new Map())
        expect(old.asked).toEqual([])
      }),
    ))

  test("gives up on a Runner that doesn't answer in time, keeping what is cached", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const r = runner()
        const first = yield* Effect.forkChild(usage.measure(r.online, [s1]))
        yield* settle
        usage.receive(studio, answer(r.ask(0), [{ sessionId: s1, bytes: 10 }]))
        yield* Fiber.join(first)

        const slow = yield* Effect.forkChild(usage.measure(r.online, [s1, s2]))
        yield* settle
        yield* TestClock.adjust(Duration.millis(SessionDiskAskTimeoutMillis))
        expect(yield* Fiber.join(slow)).toEqual(new Map([[s1, 10]]))

        // A late answer to the ask it gave up on is ignored, not kept.
        usage.receive(studio, answer(r.ask(1), [{ sessionId: s2, bytes: 99 }]))
        expect(yield* usage.measure(undefined, [s2])).toEqual(new Map())
      }),
    ))

  test("stops waiting when the Runner goes away", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const r = runner()
        const fiber = yield* Effect.forkChild(usage.measure(r.online, [s1]))
        yield* settle
        usage.runnerGone(studio)
        expect(yield* Fiber.join(fiber)).toEqual(new Map())
      }),
    ))

  test("ignores an answer from another Runner, an unknown ask, and Sessions that weren't asked", () =>
    run(
      Effect.gen(function* () {
        const usage = makeSessionDiskUsage()
        const r = runner()
        const fiber = yield* Effect.forkChild(usage.measure(r.online, [s1]))
        yield* settle
        const ask = r.ask(0)
        usage.receive(RunnerId.make("r-other"), answer(ask, [{ sessionId: s1, bytes: 1 }]))
        usage.receive(studio, { ...answer(ask, []), requestId: RequestId.make("nope") })
        usage.receive(
          studio,
          answer(ask, [
            { sessionId: s3, bytes: 7 },
            { sessionId: s1, bytes: 10 },
          ]),
        )
        expect(yield* Fiber.join(fiber)).toEqual(new Map([[s1, 10]]))
        expect(yield* usage.measure(undefined, [s3])).toEqual(new Map())
      }),
    ))
})
