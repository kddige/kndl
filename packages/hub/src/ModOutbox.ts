import {
  type ModCommand,
  ModCommandSeq,
  type QueuedModCommand,
  type SessionId,
} from "@claude-hub/protocol"
import { Context, Deferred, type Duration, Effect, Layer } from "effect"

/**
 * What the Hub has for each Session's mod, which the mod collects by long-polling
 * `GET /mod/commands`. Each Session's commands are numbered 1, 2, ... in the order they were
 * queued, and stay queued until the mod polls with a later `after`, so a poll that fails on the
 * way back loses nothing.
 *
 * Held in memory: a restarted Hub starts every outbox over from 1, and the mod, told to say
 * hello again, polls from 0.
 */
export class ModOutbox extends Context.Service<
  ModOutbox,
  {
    /** Queues a command for the Session's mod, and wakes any poll waiting for it. */
    readonly enqueue: (sessionId: SessionId, message: ModCommand) => Effect.Effect<ModCommandSeq>
    /**
     * The Session's commands numbered above `after`, oldest first, waiting up to `wait` for one
     * if there are none yet. Forgets those numbered `after` or below: the mod has handled them.
     */
    readonly take: (
      sessionId: SessionId,
      options: { readonly after: ModCommandSeq; readonly wait: Duration.Input },
    ) => Effect.Effect<ReadonlyArray<QueuedModCommand>>
    /** Drops the Session's outbox, as when the Session ends, and answers any waiting poll. */
    readonly clear: (sessionId: SessionId) => Effect.Effect<void>
  }
>()("@claude-hub/hub/ModOutbox") {
  static readonly layer = Layer.sync(ModOutbox, () => {
    interface Outbox {
      lastSeq: number
      commands: Array<QueuedModCommand>
      /** Completed, and replaced, whenever a command is queued. */
      changed: Deferred.Deferred<void>
    }
    const outboxes = new Map<SessionId, Outbox>()

    const outboxFor = (sessionId: SessionId): Outbox => {
      let outbox = outboxes.get(sessionId)
      if (outbox === undefined) {
        outbox = { lastSeq: 0, commands: [], changed: Deferred.makeUnsafe() }
        outboxes.set(sessionId, outbox)
      }
      return outbox
    }

    const wake = (outbox: Outbox) => {
      const changed = outbox.changed
      outbox.changed = Deferred.makeUnsafe()
      Deferred.doneUnsafe(changed, Effect.void)
    }

    const enqueue = (sessionId: SessionId, message: ModCommand) =>
      Effect.sync(() => {
        const outbox = outboxFor(sessionId)
        outbox.lastSeq += 1
        const seq = ModCommandSeq.make(outbox.lastSeq)
        outbox.commands.push({ seq, message })
        wake(outbox)
        return seq
      })

    /** The commands after `after`, or the signal to wait on when there are none. */
    const pending = (sessionId: SessionId, after: ModCommandSeq) =>
      Effect.sync(() => {
        const outbox = outboxFor(sessionId)
        outbox.commands = outbox.commands.filter((command) => command.seq > after)
        return { commands: [...outbox.commands], changed: outbox.changed }
      })

    const take = Effect.fn("ModOutbox.take")(function* (
      sessionId: SessionId,
      options: { readonly after: ModCommandSeq; readonly wait: Duration.Input },
    ) {
      const now = yield* pending(sessionId, options.after)
      if (now.commands.length > 0) return now.commands
      yield* Deferred.await(now.changed).pipe(Effect.timeoutOption(options.wait))
      // Read without recreating an outbox that `clear` dropped while this poll waited.
      return yield* Effect.sync(() =>
        (outboxes.get(sessionId)?.commands ?? []).filter((command) => command.seq > options.after),
      )
    })

    const clear = (sessionId: SessionId) =>
      Effect.sync(() => {
        const outbox = outboxes.get(sessionId)
        if (outbox === undefined) return
        outboxes.delete(sessionId)
        wake(outbox)
      })

    return ModOutbox.of({ enqueue, take, clear })
  })
}
