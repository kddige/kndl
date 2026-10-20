// The thread commands and Compacts each Session's durable agent hasn't taken yet
// (docs/design/durable-harness.md), kept so that none is lost: the mod outbox (ModOutbox.ts) is in
// memory, and dropped when the agent restarts, so a prompt to a thread sent then, or while the
// Session sleeps or starts, would be lost.
//
// - Each command is kept in SQLite before it is sent, numbered in the order it was kept, and is
//   sent to the mod outbox at once if the agent is up and has said hello, else after its next hello.
// - It is sent again after every hello of its agent until it is done: a prompt once a Turn starts
//   from it or it steers one, the others once the agent has polled past them. Sent twice, a
//   prompt runs once (the agent submits it with its id as its request id), and a thread starts
//   once.
// - What the mod was sent and hasn't polled past is in memory, in the Session's live state
//   (LiveSessions.ts), which clears it as the agent goes. Kept commands are cleared with the
//   Session, as when it is archived.
//
// It runs under the Session relay's lock, as part of it.

import {
  type Compact,
  type DeliverThreadPrompt,
  HubToMod,
  type ModCommandSeq,
  type PromptId,
  type SessionId,
  type StartThread,
  type StopThread,
  type SwitchThreadModel,
} from "@kndl/protocol"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { LiveSessions } from "./LiveSessions.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { Sessions } from "./Sessions.ts"

/** A command the durable agent must not lose: one about a thread, or a Compact. */
export type ModThreadCommand =
  | StartThread
  | DeliverThreadPrompt
  | StopThread
  | SwitchThreadModel
  | Compact

/** A command that carries a prompt: it is done once the prompt is. */
export type PromptCommand = StartThread | DeliverThreadPrompt

/** Whether a command carries a prompt: any command the Hub sends the mod, a thread's or not. */
export const isPromptCommand = (command: HubToMod): command is PromptCommand =>
  command._tag === "StartThread" || command._tag === "DeliverThreadPrompt"

const CommandJson = Schema.fromJsonString(HubToMod)
const encodeCommand = Schema.encodeSync(CommandJson)
const decodeCommand = Schema.decodeUnknownOption(CommandJson)

export const makeThreadOutbox = Effect.fnUntraced(function* (live: LiveSessions) {
  const sql = yield* SqlClient.SqlClient
  const sessions = yield* Sessions
  const modOutbox = yield* ModOutbox

  /** Keeps the command for the Session's agent until it is done: its number among those kept. */
  const keep = Effect.fn("ThreadOutbox.keep")(function* (
    sessionId: SessionId,
    command: ModThreadCommand,
  ) {
    const rows = yield* sql<{ readonly seq: number }>`
      INSERT INTO thread_commands (session_id, command, prompt_id)
      VALUES (${sessionId}, ${encodeCommand(command)}, ${isPromptCommand(command) ? command.promptId : null})
      RETURNING seq
    `
    return rows[0]?.seq ?? 0
  })

  /** The Session's commands not done yet, oldest first. */
  const waiting = Effect.fn("ThreadOutbox.waiting")(function* (sessionId: SessionId) {
    const rows = yield* sql<{ readonly seq: number; readonly command: string }>`
      SELECT seq, command FROM thread_commands WHERE session_id = ${sessionId} ORDER BY seq
    `
    return rows.flatMap((row) => {
      // One the Hub can no longer read is dropped from what is sent.
      const command = Option.getOrUndefined(decodeCommand(row.command))
      return command === undefined ? [] : [{ seq: row.seq, command: command as ModThreadCommand }]
    })
  })

  /**
   * Sends the Session's agent a command it hasn't taken yet: one that isn't a prompt is done once
   * the mod polls past it (`polled`), a prompt once its Turn starts or it steers one.
   */
  const enqueue = Effect.fn("ThreadOutbox.enqueue")(function* (
    sessionId: SessionId,
    kept: number,
    command: ModThreadCommand,
  ) {
    const seq = yield* modOutbox.enqueue(sessionId, command)
    if (!isPromptCommand(command)) {
      const out = live.threadCommandsOut.get(sessionId) ?? []
      live.threadCommandsOut.set(sessionId, [...out, { seq, pending: kept }])
    }
  })

  /** Sends an already kept command now, if the durable agent is ready for it: it has said hello since
   * the Hub started or relaunched it. Until then the command waits for the hello's replay. */
  const send = Effect.fn("ThreadOutbox.send")(function* (
    sessionId: SessionId,
    kept: number,
    command: ModThreadCommand,
  ) {
    const session = yield* sessions.get(sessionId)
    if (Option.isNone(session)) return
    const { state } = session.value
    const running = state === "Active" || state === "Frozen"
    if (!running || live.awaitingHello(sessionId) || !live.modGreeted(sessionId)) return
    yield* enqueue(sessionId, kept, command)
  })

  /**
   * Keeps a command before sending it. One for an agent starting, or asleep, is taken after its
   * hello, with every other command it hasn't taken.
   */
  const queue = Effect.fn("ThreadOutbox.queue")(function* (
    sessionId: SessionId,
    command: ModThreadCommand,
  ) {
    yield* send(sessionId, yield* keep(sessionId, command), command)
  })

  /** The agent said hello: the commands it hasn't taken, again, as its outbox may have been dropped. */
  const replay = Effect.fn("ThreadOutbox.replay")(function* (sessionId: SessionId) {
    for (const { seq, command } of yield* waiting(sessionId)) {
      yield* enqueue(sessionId, seq, command)
    }
  })

  /** Whether a command that isn't a prompt is on its way to the mod, for a poll to find out. */
  const sending = (sessionId: SessionId) => live.threadCommandsOut.has(sessionId)

  /** The mod polled for the commands after `after`: those that aren't prompts, up to it, are done. */
  const polled = Effect.fn("ThreadOutbox.polled")(function* (
    sessionId: SessionId,
    after: ModCommandSeq,
  ) {
    const out = live.threadCommandsOut.get(sessionId) ?? []
    const left = out.filter((sent) => sent.seq > after)
    if (left.length > 0) live.threadCommandsOut.set(sessionId, left)
    else live.threadCommandsOut.delete(sessionId)
    const done = out.filter((sent) => sent.seq <= after).map((sent) => sent.pending)
    if (done.length === 0) return
    yield* sql`
      DELETE FROM thread_commands
      WHERE session_id = ${sessionId} AND seq IN ${sql.in(done)} AND prompt_id IS NULL
    `
  })

  /** The agent took the prompt: its command is done. The command, if one carried it. */
  const promptTaken = Effect.fn("ThreadOutbox.promptTaken")(function* (
    sessionId: SessionId,
    promptId: PromptId,
  ) {
    const rows = yield* sql<{ readonly command: string }>`
      DELETE FROM thread_commands WHERE session_id = ${sessionId} AND prompt_id = ${promptId}
      RETURNING command
    `
    return Option.filter(
      Option.flatMap(Option.fromNullishOr(rows[0]), (row) => decodeCommand(row.command)),
      isPromptCommand,
    )
  })

  /** Whether a prompt waits for the agent: a command that isn't one is taken as it wakes. */
  const hasPrompts = Effect.fn("ThreadOutbox.hasPrompts")(function* (sessionId: SessionId) {
    return (yield* waiting(sessionId)).some(({ command }) => isPromptCommand(command))
  })

  /** Forgets the Session's commands, as when it is archived. */
  const clear = Effect.fn("ThreadOutbox.clear")(function* (sessionId: SessionId) {
    yield* sql`DELETE FROM thread_commands WHERE session_id = ${sessionId}`
  })

  return { keep, send, queue, replay, sending, polled, promptTaken, hasPrompts, clear }
})

export type ThreadOutbox = Effect.Success<ReturnType<typeof makeThreadOutbox>>
