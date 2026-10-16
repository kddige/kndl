// What the Hub asks its Runners of the disk their Sessions take (#352), for the archive list.
//
// A Runner measures on demand, by walking the Session's directory and its volumes, so the Hub asks
// only when a web client does (GetSessionDiskUsage), never on a timer. What a Runner says is kept
// for SessionDiskCacheMillis, so several people opening the list, or one opening it again, ask the
// Runner once. The Hub answers with what it has: a Session whose Runner is offline, or too old to
// measure, or doesn't answer within SessionDiskAskTimeoutMillis, or couldn't measure it, has no
// size, which the web shows as unknown. An unknown size is never cached.
//
// The state is the Hub's memory only. Synchronous, so it needs no lock of its own; the Session
// relay resolves the Runners under its lock and waits on the answers outside it.

import {
  MeasureSessionDisks,
  RequestId,
  type RunnerId,
  type SessionDisksMeasured,
  type SessionId,
} from "@kndl/protocol"
import { Clock, Deferred, Effect } from "effect"

/** How long a Runner's answer is used again before it is asked afresh: a minute. */
export const SessionDiskCacheMillis = 60_000

/** How long the Hub waits for a Runner to measure: walking a large Workspace can take a while. */
export const SessionDiskAskTimeoutMillis = 30_000

/** A Runner as the measuring sees it: who it is, whether it measures, and how to ask it. */
export interface DiskRunner {
  readonly id: RunnerId
  /** Whether it takes a MeasureSessionDisks (#352); one from before doesn't. */
  readonly measuresDisk: boolean
  readonly peer: { readonly send: (message: MeasureSessionDisks) => void }
}

interface Ask {
  readonly runnerId: RunnerId
  readonly sessionIds: ReadonlySet<SessionId>
  readonly answered: Deferred.Deferred<SessionDisksMeasured["sizes"]>
}

export const makeSessionDiskUsage = () => {
  /** What each Runner last said of a Session, and when. */
  const cache = new Map<SessionId, { readonly bytes: number; readonly at: number }>()
  const pending = new Map<RequestId, Ask>()

  /**
   * The size in bytes of each of the Sessions that has one: cached, or asked of its `runner`. A
   * Session without an entry is unknown. All of them are on the one Runner, if it is online.
   */
  const measure = Effect.fn("SessionDiskUsage.measure")(function* (
    runner: DiskRunner | undefined,
    sessionIds: ReadonlyArray<SessionId>,
  ) {
    const sizes = new Map<SessionId, number>()
    const now = yield* Clock.currentTimeMillis
    const missing: Array<SessionId> = []
    for (const sessionId of sessionIds) {
      const cached = cache.get(sessionId)
      if (cached !== undefined && now - cached.at < SessionDiskCacheMillis) {
        sizes.set(sessionId, cached.bytes)
      } else {
        cache.delete(sessionId)
        missing.push(sessionId)
      }
    }
    if (runner === undefined || !runner.measuresDisk || missing.length === 0) return sizes

    const requestId = RequestId.make(crypto.randomUUID())
    const answered = yield* Deferred.make<SessionDisksMeasured["sizes"]>()
    pending.set(requestId, { runnerId: runner.id, sessionIds: new Set(missing), answered })
    runner.peer.send(MeasureSessionDisks.make({ requestId, sessionIds: missing }))
    const heard = yield* Deferred.await(answered).pipe(
      Effect.timeoutOption(SessionDiskAskTimeoutMillis),
      Effect.ensuring(Effect.sync(() => void pending.delete(requestId))),
    )
    if (heard._tag === "None") return sizes
    const at = yield* Clock.currentTimeMillis
    for (const { sessionId, bytes } of heard.value) {
      if (bytes === undefined) continue
      cache.set(sessionId, { bytes, at })
      sizes.set(sessionId, bytes)
    }
    return sizes
  })

  return {
    measure,
    /** The Runner's answer to an ask. One from another Runner, or to no ask, is ignored. */
    receive: (runnerId: RunnerId, message: SessionDisksMeasured) => {
      const ask = pending.get(message.requestId)
      if (ask === undefined || ask.runnerId !== runnerId) return
      pending.delete(message.requestId)
      Deferred.doneUnsafe(
        ask.answered,
        Effect.succeed(message.sizes.filter(({ sessionId }) => ask.sessionIds.has(sessionId))),
      )
    },
    /** The Runner went offline: its asks end with nothing. */
    runnerGone: (runnerId: RunnerId) => {
      for (const [requestId, ask] of pending) {
        if (ask.runnerId !== runnerId) continue
        pending.delete(requestId)
        Deferred.doneUnsafe(ask.answered, Effect.succeed([]))
      }
    },
    /** The Session is purged: whatever was known of it goes. */
    forget: (sessionId: SessionId) => void cache.delete(sessionId),
  }
}
