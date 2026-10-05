// The tool calls one Session's bridge is running, by the id the mod gave each (#109).
//
// A call may run for minutes while each HTTP exchange with the mod lasts at most MaxToolWaitMs, so
// a call outlives the request that started it. The mod waits for it in steps and cancels it when
// it gives up. A call nothing has waited for in `abandonAfter` is cancelled as well, as when Claude
// Code went away mid-call, and closing the scope (the Session's Sandbox stopping) cancels every
// call still running. An ended call's reply is kept for `keepFor`, so a step whose answer was
// lost can be asked again.

import type { BridgeCallId, ToolCallReply } from "@claude-hub/protocol"
import { ToolCallReply as Reply } from "@claude-hub/protocol"
import { Deferred, Duration, Effect, Fiber, Option } from "effect"
import type { Scope } from "effect"

export interface ToolCallsOptions {
  /** How long a running call may go with nothing waiting for it before it is cancelled. */
  readonly abandonAfter?: Duration.Input
  /** How long an ended call's reply is kept for the mod to collect. */
  readonly keepFor?: Duration.Input
}

/**
 * Runs one call. `cancelled` completes, with why, when the call is to stop: the run then stops what
 * it started and replies at once.
 */
export type RunCall = (cancelled: Effect.Effect<string>) => Effect.Effect<ToolCallReply>

export interface ToolCalls {
  /** Starts a call under `callId`; one already known by that id is left as it is. */
  readonly start: (callId: BridgeCallId, run: RunCall) => Effect.Effect<void>
  /**
   * Waits up to `wait` for the call to end. Its reply, `ToolRunning` if it is still running, or
   * undefined for a call by an id not known (or no longer kept).
   */
  readonly wait: (
    callId: BridgeCallId,
    wait: Duration.Input,
  ) => Effect.Effect<ToolCallReply | undefined>
  /**
   * Cancels the call, and waits for it to stop. Its reply: the one it had ended with, or what it
   * stopped with; undefined for a call by an id not known.
   */
  readonly cancel: (callId: BridgeCallId, why: string) => Effect.Effect<ToolCallReply | undefined>
}

interface Entry {
  readonly done: Deferred.Deferred<ToolCallReply>
  readonly cancelled: Deferred.Deferred<string>
  /** How many waits are under way. */
  waiting: number
  /** Counts down to cancelling the call while nothing waits for it. */
  abandon: Fiber.Fiber<void> | undefined
}

const lost = (message: string) => Reply.cases.ToolLost.make({ message })

export const makeToolCalls = (
  options: ToolCallsOptions = {},
): Effect.Effect<ToolCalls, never, Scope.Scope> =>
  Effect.gen(function* () {
    const abandonAfter = Duration.fromInputUnsafe(options.abandonAfter ?? Duration.seconds(30))
    const keepFor = options.keepFor ?? Duration.minutes(2)
    const scope = yield* Effect.scope
    const entries = new Map<BridgeCallId, Entry>()

    const stopCountdown = (entry: Entry) =>
      Effect.suspend(() => {
        const fiber = entry.abandon
        entry.abandon = undefined
        return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
      })

    /** Starts counting down to cancelling a call nothing waits for. */
    const startCountdown = (entry: Entry) =>
      Effect.gen(function* () {
        if (entry.waiting > 0 || entry.abandon !== undefined) return
        if (yield* Deferred.isDone(entry.done)) return
        entry.abandon = yield* Effect.sleep(abandonAfter).pipe(
          Effect.andThen(
            Deferred.succeed(
              entry.cancelled,
              `nothing waited for it for ${Duration.toSeconds(abandonAfter)} seconds`,
            ),
          ),
          Effect.asVoid,
          Effect.forkIn(scope),
        )
      })

    const start = (callId: BridgeCallId, run: RunCall) =>
      Effect.gen(function* () {
        if (entries.has(callId)) return
        const entry: Entry = {
          done: yield* Deferred.make<ToolCallReply>(),
          cancelled: yield* Deferred.make<string>(),
          waiting: 0,
          abandon: undefined,
        }
        entries.set(callId, entry)
        yield* run(Deferred.await(entry.cancelled)).pipe(
          // Interrupted only as the scope closes; whoever waits hears that the call stopped.
          Effect.onInterrupt(() =>
            Deferred.succeed(
              entry.done,
              lost("the tool bridge closed while it ran, and stopped it"),
            ),
          ),
          Effect.flatMap((reply) => Deferred.succeed(entry.done, reply)),
          Effect.andThen(stopCountdown(entry)),
          Effect.andThen(Effect.sleep(keepFor)),
          Effect.ensuring(
            Effect.sync(() => {
              if (entries.get(callId) === entry) entries.delete(callId)
            }),
          ),
          Effect.forkIn(scope),
        )
        yield* startCountdown(entry)
      })

    const wait = (callId: BridgeCallId, upTo: Duration.Input) =>
      Effect.suspend(() => {
        const entry = entries.get(callId)
        if (entry === undefined) return Effect.succeed(undefined)
        entry.waiting += 1
        return stopCountdown(entry).pipe(
          Effect.andThen(Deferred.await(entry.done).pipe(Effect.timeoutOption(upTo))),
          Effect.map(Option.getOrElse(() => Reply.cases.ToolRunning.make({ callId }))),
          Effect.ensuring(
            Effect.suspend(() => {
              entry.waiting -= 1
              return startCountdown(entry)
            }),
          ),
        )
      })

    const cancel = (callId: BridgeCallId, why: string) =>
      Effect.suspend(() => {
        const entry = entries.get(callId)
        if (entry === undefined) return Effect.succeed(undefined)
        return Deferred.succeed(entry.cancelled, why).pipe(
          Effect.andThen(Deferred.await(entry.done)),
        )
      })

    return { start, wait, cancel }
  })
