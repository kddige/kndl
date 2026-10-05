import { describe, expect, test } from "bun:test"
import { MaxToolWaitMs, ToolCallReply } from "@claude-hub/protocol"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeToolCalls } from "./ToolCalls.ts"
import type { RunCall } from "./ToolCalls.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer())))

const ran = (stdout: string) => ToolCallReply.cases.ToolRan.make({ result: { stdout } })

/** A tool that takes `seconds`, or stops with ToolLost when cancelled; `killed` notes that. */
const tool = (seconds: number, killed: Array<string> = []): RunCall => {
  return (cancelled) =>
    Effect.raceFirst(
      Effect.sleep(`${seconds} seconds`).pipe(Effect.as(ran(`slept ${seconds}`))),
      Effect.map(cancelled, (why) => {
        killed.push(why)
        return ToolCallReply.cases.ToolLost.make({ message: why })
      }),
    )
}

describe("ToolCalls", () => {
  test("a 45-second call is waited for in steps, and returns its result", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* makeToolCalls()
        yield* calls.start("c1", tool(45))
        const replies: Array<string> = []
        let reply: ToolCallReply | undefined
        do {
          const waiting = yield* Effect.forkChild(calls.wait("c1", MaxToolWaitMs))
          yield* TestClock.adjust(MaxToolWaitMs)
          reply = yield* Fiber.join(waiting)
          replies.push(reply?._tag ?? "unknown")
        } while (reply?._tag === "ToolRunning")
        expect(replies).toEqual(["ToolRunning", "ToolRunning", "ToolRan"])
        expect(reply).toEqual(ran("slept 45"))
      }),
    ))

  test("starting a known call again starts nothing", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* makeToolCalls()
        let runs = 0
        const counted: RunCall = (cancelled) =>
          Effect.suspend(() => {
            runs += 1
            return tool(5)(cancelled)
          })
        yield* calls.start("c1", counted)
        yield* calls.start("c1", counted)
        yield* Effect.yieldNow
        expect(runs).toBe(1)
      }),
    ))

  test("cancelling a call stops it, and its waiters hear at once", () =>
    run(
      Effect.gen(function* () {
        const killed: Array<string> = []
        const calls = yield* makeToolCalls()
        yield* calls.start("c1", tool(600, killed))
        const waiting = yield* Effect.forkChild(calls.wait("c1", MaxToolWaitMs))
        yield* Effect.yieldNow
        const reply = yield* calls.cancel("c1", "the turn was interrupted")
        expect(reply).toEqual(
          ToolCallReply.cases.ToolLost.make({ message: "the turn was interrupted" }),
        )
        expect(yield* Fiber.join(waiting)).toEqual(reply)
        expect(killed).toEqual(["the turn was interrupted"])
      }),
    ))

  test("cancelling a call that ended answers its result", () =>
    run(
      Effect.gen(function* () {
        const killed: Array<string> = []
        const calls = yield* makeToolCalls()
        yield* calls.start("c1", tool(1, killed))
        yield* TestClock.adjust("1 second")
        expect(yield* calls.cancel("c1", "too late")).toEqual(ran("slept 1"))
        expect(killed).toEqual([])
      }),
    ))

  test("a call nothing waits for is cancelled once it has been left alone long enough", () =>
    run(
      Effect.gen(function* () {
        const killed: Array<string> = []
        const calls = yield* makeToolCalls({ abandonAfter: "30 seconds" })
        yield* calls.start("c1", tool(600, killed))
        // Waiting keeps it alive, however long it runs.
        for (let step = 0; step < 10; step++) {
          const waiting = yield* Effect.forkChild(calls.wait("c1", MaxToolWaitMs))
          yield* TestClock.adjust(MaxToolWaitMs)
          expect((yield* Fiber.join(waiting))?._tag).toBe("ToolRunning")
          yield* TestClock.adjust("29 seconds")
        }
        expect(killed).toEqual([])
        yield* TestClock.adjust("1 second")
        expect(killed).toEqual(["nothing waited for it for 30 seconds"])
      }),
    ))

  test("an ended call's reply is kept for a while, then forgotten", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* makeToolCalls({ keepFor: "2 minutes" })
        yield* calls.start("c1", tool(1))
        yield* TestClock.adjust("1 second")
        yield* TestClock.adjust("119 seconds")
        expect(yield* calls.wait("c1", 0)).toEqual(ran("slept 1"))
        yield* TestClock.adjust("1 second")
        expect(yield* calls.wait("c1", 0)).toBeUndefined()
      }),
    ))

  test("closing the scope cancels every running call, and answers its waiters", () =>
    run(
      Effect.gen(function* () {
        const interrupted: Array<string> = []
        const scope = yield* Scope.make()
        const calls = yield* makeToolCalls().pipe(Scope.provide(scope))
        const forever =
          (id: string): RunCall =>
          () =>
            Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.push(id))))
        yield* calls.start("c1", forever("c1"))
        yield* calls.start("c2", forever("c2"))
        const done = yield* Deferred.make<ToolCallReply | undefined>()
        yield* calls.wait("c1", "1 hour").pipe(
          Effect.flatMap((reply) => Deferred.succeed(done, reply)),
          Effect.forkDetach,
        )
        yield* Effect.yieldNow
        yield* Scope.close(scope, Exit.void)
        expect(interrupted.toSorted()).toEqual(["c1", "c2"])
        expect(yield* Deferred.await(done)).toMatchObject({ _tag: "ToolLost" })
      }),
    ))

  test("a call by an unknown id is undefined", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* makeToolCalls()
        expect(yield* calls.wait("nope", 0)).toBeUndefined()
        expect(yield* calls.cancel("nope", "why")).toBeUndefined()
      }),
    ))
})
